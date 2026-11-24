import type { JobResult } from 'pg-boss';
import type { Logger } from '../logging/logging.module';

/** The part of a pg-boss job (with metadata) the runner needs. */
export interface RunnableJob {
  id: string;
  data: unknown;
  retryCount: number;
  retryLimit: number;
}

/**
 * What a job may return to be stored as the pg-boss job's output. Fixed codes and identifiers only: the
 * output sits in `pgboss.job`, which has no RLS (docs/04 section 4).
 */
export type JobOutput = Record<string, string | number | boolean>;

/** When a scheduled job fires: a cron expression evaluated in an IANA time zone. */
export interface ScheduleSpec {
  cron: string;
  tz: string;
}

/**
 * What the `JobRunner` needs from a job: its queue and a function that runs one pg-boss job and translates
 * the outcome. `TenantJob` (work inside one tenant) and `SystemJob` (platform work with no tenant) both
 * implement it. A job with a `schedule` is also fired by pg-boss's cron (see `ScheduleRegistrar`).
 */
export interface RegisteredJob {
  /** pg-boss queue name; also the job's name in logs. */
  readonly queue: string;
  readonly schedule?: ScheduleSpec;
  /** Run one job. Never throws. */
  execute(job: RunnableJob, root: Logger): Promise<JobResult>;
}
