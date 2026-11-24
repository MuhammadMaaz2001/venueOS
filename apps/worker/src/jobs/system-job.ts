import type { JobResult } from 'pg-boss';
import type { z } from 'zod';
import type { Logger } from '../logging/logging.module';
import type { JobOutput, RegisteredJob, RunnableJob, ScheduleSpec } from './registered-job';
import { PermanentJobError, RetryableJobError, describeError } from './tenant-job';

/**
 * Base class of platform jobs that belong to no tenant: `auth.purge`, scanners, the dead-letter check.
 * (`TenantJob` is the base of everything that works inside one tenant; apps/worker/CLAUDE.md.)
 *
 * Same rules as `TenantJob`: the payload is validated with a Zod schema first (identifiers only, `.strict()`),
 * failures use the fixed codes (`RetryableJobError` / `PermanentJobError`, never raw error text), jobs are
 * idempotent. A system job has no `tx`: it uses the connection it was built for (`AuthDb`, `ScannerDb`, ...),
 * never `TenantDb` for another tenant's data.
 */
export interface SystemJobContext<P> {
  jobId: string;
  queue: string;
  payload: P;
  attempt: number;
  maxAttempts: number;
  isLastAttempt: boolean;
  log: Logger;
}

export abstract class SystemJob<P extends object = Record<string, never>> implements RegisteredJob {
  abstract readonly queue: string;
  /** Set it and the job also runs on a cron schedule (registered at worker start, in `schedule()`). */
  readonly schedule?: ScheduleSpec;
  protected abstract readonly payloadSchema: z.ZodType<P>;

  protected abstract handle(ctx: SystemJobContext<P>): Promise<JobOutput | void>;

  async execute(job: RunnableJob, root: Logger): Promise<JobResult> {
    const attempt = job.retryCount + 1;
    const maxAttempts = job.retryLimit + 1;
    const isLastAttempt = job.retryCount >= job.retryLimit;
    const log = root.child({ jobId: job.id, queue: this.queue, attempt });

    const parsed = this.payloadSchema.safeParse(job.data);
    if (!parsed.success) {
      log.error({ code: 'INVALID_PAYLOAD' }, 'job payload is invalid, dead-lettering');
      return { id: job.id, status: 'deadletter', output: { code: 'INVALID_PAYLOAD' } };
    }

    try {
      const output = await this.handle({
        jobId: job.id,
        queue: this.queue,
        payload: parsed.data,
        attempt,
        maxAttempts,
        isLastAttempt,
        log,
      });
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
