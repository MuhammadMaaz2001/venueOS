import { JOB_RETRY } from '@venueos/shared';
import { z } from 'zod';
import { SystemJob } from '../jobs/system-job';
import type { SystemJobContext } from '../jobs/system-job';
import type { Logger } from '../logging/logging.module';
import type { PgBossService } from '../queue/pg-boss.service';
import type { PageOptions, ScanRow, ScannerDb } from './scanner-db';

/** Most items one scan run enqueues. A runaway query logs a warning and stops instead of flooding the queue. */
export const SCAN_MAX_ITEMS = 100_000;

/** The job a scanner enqueues for each item it finds: its queue, strict payload schema and expiry. */
export interface ScanTarget<P extends object> {
  queue: string;
  payloadSchema: z.ZodType<P>;
  expireInSeconds: number;
}

export interface ScanContext {
  jobId: string;
  log: Logger;
  /** Pages of identifiers found by a static query (see `ScannerDb.pages`). */
  pages(
    text: string,
    values?: readonly unknown[],
    options?: PageOptions,
  ): AsyncGenerator<ScanRow[]>;
  /**
   * Enqueue one job for one item. The payload is validated against the target's strict schema (identifiers
   * only, no customer data) and sent with a singleton key, so running the scan twice does not queue the same
   * item twice. Returns false when a job with that key is already queued.
   */
  enqueue<P extends object>(
    target: ScanTarget<P>,
    payload: P,
    singletonKey: string,
  ): Promise<boolean>;
}

const noPayload = z.object({}).strict();

class ScanLimitError extends Error {
  constructor() {
    super('SCAN_LIMIT');
    this.name = 'ScanLimitError';
  }
}

/**
 * Base class of a scanner (apps/worker/CLAUDE.md): a scheduled `SystemJob` that finds due work across tenants
 * with the `venueos_jobs` connection, reading identifiers only, and enqueues one job per tenant item. It never
 * does the work itself and never touches tenant data beyond the ids.
 *
 * To add a scanner: a migration creating its queue (and any new scanner SELECT grant, with a reason), a
 * subclass with `queue`, `schedule` and `scan`, and a line in the jobs list of `JobsModule`.
 */
export abstract class Scanner extends SystemJob {
  protected readonly payloadSchema = noPayload;

  constructor(
    private readonly scannerDb: ScannerDb,
    private readonly pgBoss: PgBossService,
  ) {
    super();
  }

  protected abstract scan(ctx: ScanContext): Promise<void>;

  protected async handle(ctx: SystemJobContext<Record<string, never>>): Promise<void> {
    let enqueued = 0;
    let found = 0;
    const scanCtx: ScanContext = {
      jobId: ctx.jobId,
      log: ctx.log,
      pages: (text, values, options) => this.scannerDb.pages(text, values, options),
      enqueue: async (target, payload, singletonKey) => {
        found += 1;
        if (found > SCAN_MAX_ITEMS) throw new ScanLimitError();
        const data = target.payloadSchema.parse(payload);
        const id = await this.pgBoss.boss.send(target.queue, data, {
          singletonKey,
          retryLimit: JOB_RETRY.retryLimit,
          retryDelay: JOB_RETRY.retryDelaySeconds,
          retryBackoff: JOB_RETRY.retryBackoff,
          retryDelayMax: JOB_RETRY.retryDelayMaxSeconds,
          expireInSeconds: target.expireInSeconds,
          deadLetter: `${target.queue}.dead`,
        });
        if (id) enqueued += 1;
        return id !== null;
      },
    };
    try {
      await this.scan(scanCtx);
    } catch (error) {
      if (error instanceof ScanLimitError) {
        ctx.log.warn({ limit: SCAN_MAX_ITEMS, enqueued }, 'scan stopped at the item limit');
      } else {
        throw error;
      }
    }
    ctx.log.info({ found, enqueued, alreadyQueued: found - enqueued }, 'scan finished');
  }
}

export type { Logger };
