import type { DbTx, TenantDb } from '@venueos/db';
import type { JobResult } from 'pg-boss';
import type { z } from 'zod';
import type { Logger } from '../logging/logging.module';
import type { JobOutput, RegisteredJob, RunnableJob } from './registered-job';

/**
 * Base class of every job (apps/worker/CLAUDE.md).
 *
 * - The payload always carries `tenantId` and is validated with a Zod schema before anything runs.
 * - Database work goes through `ctx.tx()`, a `TenantDb` transaction for THAT tenant (role venueos_app, RLS
 *   applies). Keep each transaction short: do slow external work (SMTP, S3, ...) between transactions,
 *   never inside one.
 * - Idempotency: enqueue with a singleton key, and check state before acting (jobs run at least once).
 * - Failures: throw `RetryableJobError(code)` (or any other error: code `UNEXPECTED`) to use the retry
 *   policy (exponential backoff, max 5 retries, then the dead-letter queue); throw `PermanentJobError(code)`
 *   when a retry can never help: the job is dead-lettered immediately.
 * - Only fixed codes are stored on the pg-boss job and in logs; never raw error text (it can contain
 *   addresses or credentials), email bodies or customer data.
 */

/** A failure that no retry can fix. The job goes straight to the dead-letter queue. */
export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentJobError';
  }
}

/** A failure worth retrying; `code` is a short fixed code (never provider text). */
export class RetryableJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RetryableJobError';
  }
}

export interface JobContext<P> {
  jobId: string;
  queue: string;
  payload: P;
  tenantId: string;
  /** 1-based number of this attempt. */
  attempt: number;
  /** Attempts the job gets in total (1 + retry limit). */
  maxAttempts: number;
  isLastAttempt: boolean;
  /** Logger that already carries jobId, tenantId, queue and attempt on every line. */
  log: Logger;
  /** A short transaction for this job's tenant. */
  tx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}

/** What `onInvalidPayload` gets: whatever could be read from a payload that failed validation. */
export interface InvalidPayloadInfo {
  jobId: string;
  /** Only when `data.tenantId` is a well-formed identifier. */
  tenantId: string | undefined;
  messageKey: string | undefined;
  attempt: number;
  log: Logger;
  tx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function readId(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

/** Name and code of an error, never its message (driver messages can contain secrets and addresses). */
export function describeError(error: unknown): { errorName: string; errorCode?: string } {
  if (typeof error !== 'object' || error === null) return { errorName: typeof error };
  const { name, code } = error as { name?: unknown; code?: unknown };
  return {
    errorName: typeof name === 'string' ? name : 'Error',
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  };
}

export abstract class TenantJob<P extends { tenantId: string }> implements RegisteredJob {
  /** pg-boss queue name; also the job's name in logs. */
  abstract readonly queue: string;
  protected abstract readonly payloadSchema: z.ZodType<P>;

  constructor(protected readonly tenantDb: TenantDb) {}

  protected abstract handle(ctx: JobContext<P>): Promise<JobOutput | void>;

  /**
   * The payload failed validation. Record the permanent failure if that is possible (the default does
   * nothing). Errors thrown here are logged and swallowed: the job is dead-lettered either way.
   */
  protected onInvalidPayload(info: InvalidPayloadInfo): Promise<void> {
    void info;
    return Promise.resolve();
  }

  /** Run one job and translate the outcome for pg-boss. Never throws. */
  async execute(job: RunnableJob, root: Logger): Promise<JobResult> {
    const attempt = job.retryCount + 1;
    const maxAttempts = job.retryLimit + 1;
    const isLastAttempt = job.retryCount >= job.retryLimit;
    const rawTenantId = readId(job.data, 'tenantId');
    const log = root.child({
      jobId: job.id,
      queue: this.queue,
      tenantId: rawTenantId ?? null,
      attempt,
    });
    const txFor =
      (tenantId: string | undefined) =>
      <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> => {
        if (!tenantId) return Promise.reject(new Error('no valid tenant in the job payload'));
        return this.tenantDb.tx({ tenantId }, fn);
      };

    const parsed = this.payloadSchema.safeParse(job.data);
    if (!parsed.success) {
      log.error({ code: 'INVALID_PAYLOAD' }, 'job payload is invalid, dead-lettering');
      try {
        await this.onInvalidPayload({
          jobId: job.id,
          tenantId: rawTenantId,
          messageKey: readId(job.data, 'messageKey'),
          attempt,
          log,
          tx: txFor(rawTenantId),
        });
      } catch (error) {
        log.error(describeError(error), 'could not record the invalid payload');
      }
      return { id: job.id, status: 'deadletter', output: { code: 'INVALID_PAYLOAD' } };
    }

    const payload = parsed.data;
    const ctx: JobContext<P> = {
      jobId: job.id,
      queue: this.queue,
      payload,
      tenantId: payload.tenantId,
      attempt,
      maxAttempts,
      isLastAttempt,
      log,
      tx: txFor(payload.tenantId),
    };

    try {
      const output = await this.handle(ctx);
      return { id: job.id, status: 'completed', ...(output ? { output } : {}) };
    } catch (error) {
      if (error instanceof PermanentJobError) {
        log.error({ code: error.code }, 'job failed permanently, dead-lettering');
        return { id: job.id, status: 'deadletter', output: { code: error.code } };
      }
      const code = error instanceof RetryableJobError ? error.code : 'UNEXPECTED';
      log.error(
        { code, willRetry: !isLastAttempt, ...(code === 'UNEXPECTED' ? describeError(error) : {}) },
        isLastAttempt ? 'job failed, no retries left (dead letter)' : 'job failed, will retry',
      );
      return { id: job.id, status: 'failed', output: { code } };
    }
  }
}
