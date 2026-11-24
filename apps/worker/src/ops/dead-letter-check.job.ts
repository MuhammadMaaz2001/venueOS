import { JOB_NAMES } from '@venueos/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { ScheduleSpec } from '../jobs/registered-job';
import { SystemJob } from '../jobs/system-job';
import type { SystemJobContext } from '../jobs/system-job';

export interface DeadLetterQueueStatus {
  queue: string;
  count: number;
  oldestSeconds: number;
}

/** The exact log message the CloudWatch metric filter matches (docs/08, Monitoring). Do not reword it. */
export const DEAD_LETTERS_PRESENT = 'dead letters present';

/**
 * `ops.dead-letter-check`: every 5 minutes, logs one ERROR line per dead-letter queue (`*.dead`) that holds
 * jobs: `{ queue, count, oldestSeconds }`. docs/08 alarms on that line, so any dead letter pages someone.
 * It only counts and logs: it never reads a job's payload, and never fails because dead letters exist.
 *
 * Runs on the worker's `venueos_jobs` connection (read on the `pgboss` schema). Dead letters are inspected
 * and redriven with `packages/db/scripts/dead-letters.mjs` (docs/08 runbook).
 */
export class DeadLetterCheckJob extends SystemJob {
  readonly queue = JOB_NAMES.OPS_DEAD_LETTER_CHECK;
  override readonly schedule: ScheduleSpec = { cron: '*/5 * * * *', tz: 'UTC' };
  protected readonly payloadSchema = z.object({}).strict();

  /** @param pool a pool on JOBS_DATABASE_URL (role venueos_jobs) */
  constructor(private readonly pool: pg.Pool) {
    super();
  }

  protected async handle(ctx: SystemJobContext<Record<string, never>>): Promise<void> {
    const queues = await this.check();
    for (const status of queues) {
      ctx.log.error(status, DEAD_LETTERS_PRESENT);
    }
    if (queues.length === 0) ctx.log.debug('no dead letters');
  }

  /** Dead-letter queues that hold at least one job. Exposed for tests. */
  async check(): Promise<DeadLetterQueueStatus[]> {
    const { rows } = await this.pool.query<{
      queue: string;
      count: number;
      oldest_seconds: number;
    }>(
      `SELECT name AS queue,
              count(*)::int AS count,
              COALESCE(EXTRACT(EPOCH FROM now() - min(created_on)), 0)::int AS oldest_seconds
         FROM pgboss.job
        WHERE name LIKE '%.dead'
        GROUP BY name
        ORDER BY name`,
    );
    return rows.map((row) => ({
      queue: row.queue,
      count: row.count,
      oldestSeconds: row.oldest_seconds,
    }));
  }
}
