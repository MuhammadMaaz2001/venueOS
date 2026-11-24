import { randomUUID } from 'node:crypto';
import {
  EMAIL_SEND_EXPIRE_SECONDS,
  PDF_RENDER_EXPIRE_SECONDS,
  SEALED_VARS_KEY,
  JOB_NAMES,
  JOB_RETRY,
  emailSendPayloadSchema,
  enqueueEmailInputSchema,
  pdfRenderPayloadSchema,
} from '@venueos/shared';
import type { EmailSendPayload, EnqueueEmailInput, PdfRenderPayload } from '@venueos/shared';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import type { DbTx } from '../client.js';
import type { Sealer } from '../crypto/seal.js';
import { pgBossDb } from '../pgboss-adapter.js';
import { sealedVarsAad } from './sealed-vars.js';

/** Job name -> payload type. A job whose payload is not listed here cannot be enqueued. */
export interface JobPayloads {
  [JOB_NAMES.EMAIL_SEND]: EmailSendPayload;
  [JOB_NAMES.PDF_RENDER]: PdfRenderPayload;
}
export type EnqueueableJob = keyof JobPayloads;

const PAYLOAD_SCHEMAS = {
  [JOB_NAMES.EMAIL_SEND]: emailSendPayloadSchema,
  [JOB_NAMES.PDF_RENDER]: pdfRenderPayloadSchema,
} as const;

const DEAD_LETTER_OF: Record<EnqueueableJob, string> = {
  [JOB_NAMES.EMAIL_SEND]: JOB_NAMES.EMAIL_SEND_DEAD,
  [JOB_NAMES.PDF_RENDER]: JOB_NAMES.PDF_RENDER_DEAD,
};

const EXPIRE_SECONDS_OF: Record<EnqueueableJob, number> = {
  [JOB_NAMES.EMAIL_SEND]: EMAIL_SEND_EXPIRE_SECONDS,
  [JOB_NAMES.PDF_RENDER]: PDF_RENDER_EXPIRE_SECONDS,
};

export interface RetryPolicy {
  retryLimit: number;
  retryDelaySeconds: number;
  retryDelayMaxSeconds: number;
  retryBackoff: boolean;
}

/** Options of `JobQueue.send`. The singleton key is mandatory: see `send`. */
export interface SendOptions {
  singletonKey: string;
}

export interface JobQueueOptions {
  /**
   * Postgres URL of the role that enqueues (venueos_app). The pool opened from it is used ONLY for
   * pg-boss's cached read of the queue definitions; jobs are inserted with the caller's transaction.
   */
  connectionString: string;
  /** Override the retry policy of every job (tests shorten the delays; production never sets it). */
  retry?: Partial<RetryPolicy>;
}

/** The schema every pg-boss object lives in. Created by the migrator; see the pg-boss migration. */
export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Enqueue side of the job system, used by the API (and by tests). It never calls `start()` (no timers, no
 * maintenance). Every job is inserted with the caller's TRANSACTION (`send(tx, ...)`), so a job exists
 * if and only if the surrounding business change committed. The small pool is only for pg-boss's
 * cached lookup of queue definitions. (docs/02-system-design.md, request lifecycle; docs/04 section 4.)
 */
export class JobQueue {
  private readonly boss: PgBoss;
  private readonly pool: pg.Pool;
  private readonly retry: RetryPolicy;

  constructor(options: JobQueueOptions) {
    if (!options.connectionString) throw new Error('A database connection string is required');
    this.retry = {
      retryLimit: JOB_RETRY.retryLimit,
      retryDelaySeconds: JOB_RETRY.retryDelaySeconds,
      retryDelayMaxSeconds: JOB_RETRY.retryDelayMaxSeconds,
      retryBackoff: JOB_RETRY.retryBackoff,
      ...options.retry,
    };
    this.pool = new pg.Pool({ connectionString: options.connectionString, max: 2 });
    // An idle client can fail (database restart); without a listener that would crash the process.
    this.pool.on('error', () => undefined);
    this.boss = new PgBoss({
      db: {
        executeSql: async (text, values) => {
          const result = await this.pool.query(text, values as unknown[] | undefined);
          return { rows: result.rows };
        },
      },
      schema: PGBOSS_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    // Never started, so it emits nothing; the listener keeps a stray 'error' from being fatal.
    this.boss.on('error', () => undefined);
  }

  /** Close the pool (Nest `onApplicationShutdown`, test teardown). */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Insert a job in `tx`. `singletonKey` is REQUIRED (a type error to leave out) and makes the enqueue
   * idempotent: while a job with the same key is still queued, a second send returns `null` instead of adding
   * another. It is required because every queue uses the `short` policy, which allows ONE queued job per key and
   * one when there is no key: a keyless job would silently drop every later job of its queue (docs/08). Use a key
   * that names the thing the job is about (`messageKey`, `kind:entityId`).
   * The payload is validated against the job's schema; extra keys are rejected, so customer data cannot
   * leak into `pgboss.job`.
   *
   * @returns the job id, or `null` when a job with the same singleton key is already queued
   * @throws Error when the key is empty (the type cannot tell `''` from a real key)
   */
  async send<N extends EnqueueableJob>(
    tx: DbTx,
    name: N,
    payload: JobPayloads[N],
    options: SendOptions,
  ): Promise<string | null> {
    if (!options.singletonKey) throw new Error('JobQueue.send: singletonKey must not be empty');
    const data = PAYLOAD_SCHEMAS[name].parse(payload);
    return this.boss.send(name, data, {
      db: pgBossDb(tx),
      singletonKey: options.singletonKey,
      retryLimit: this.retry.retryLimit,
      retryDelay: this.retry.retryDelaySeconds,
      retryBackoff: this.retry.retryBackoff,
      // pg-boss only accepts a delay cap together with backoff.
      ...(this.retry.retryBackoff ? { retryDelayMax: this.retry.retryDelayMaxSeconds } : {}),
      expireInSeconds: EXPIRE_SECONDS_OF[name],
      deadLetter: DEAD_LETTER_OF[name],
    });
  }
}

export interface EnqueuedEmail {
  messageKey: string;
  jobId: string;
}

/**
 * Queue an email inside the business transaction: appends the `queued` row to `message_logs` (recipient,
 * template, locale, variables, reply-to: all customer data stays here, under RLS) and enqueues
 * `email.send` with `{ tenantId, messageKey }` only. If the transaction rolls back, neither exists.
 *
 * `tenantId` must be the tenant of `tx` (Row Level Security rejects the insert otherwise).
 *
 * @throws ZodError when the input is invalid (a programming error in the calling module)
 */
export async function enqueueEmail(
  queue: JobQueue,
  tx: DbTx,
  tenantId: string,
  input: EnqueueEmailInput,
  options: { sealer?: Sealer } = {},
): Promise<EnqueuedEmail> {
  const data = enqueueEmailInputSchema.parse(input);
  const messageKey = randomUUID();
  // Secret variables (links with tokens) are sealed, bound to this exact row by the AAD, and stored inside
  // template_vars; they are never written in plain text anywhere (docs/04-security.md section 6).
  const secrets =
    data.secretVars && Object.keys(data.secretVars).length > 0 ? data.secretVars : null;
  if (secrets && !options.sealer) {
    throw new Error('enqueueEmail: secretVars need a sealer (FIELD_ENCRYPTION_KEYS)');
  }
  const templateVars = secrets
    ? {
        ...data.vars,
        [SEALED_VARS_KEY]: (options.sealer as Sealer).seal(
          JSON.stringify(secrets),
          sealedVarsAad(tenantId, messageKey),
        ),
      }
    : data.vars;
  await tx.messageLog.create({
    data: {
      tenantId,
      messageKey,
      channel: 'email',
      to: data.to,
      replyTo: data.replyTo ?? null,
      event: data.event ?? null,
      entityType: data.entityType ?? null,
      entityId: data.entityId ?? null,
      status: 'queued',
      template: data.template,
      locale: data.locale,
      templateVars,
    },
  });
  const jobId = await queue.send(
    tx,
    JOB_NAMES.EMAIL_SEND,
    { tenantId, messageKey },
    { singletonKey: messageKey },
  );
  if (!jobId) throw new Error('email.send was not enqueued (is the queue installed?)');
  return { messageKey, jobId };
}
