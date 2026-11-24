import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { JOB_RETRY } from '@venueos/shared';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { LOGGER } from '../logging/logging.module';
import type { Logger } from '../logging/logging.module';
import { PgBossService } from '../queue/pg-boss.service';
import { JOBS } from './job-runner';
import type { AnyJob } from './job-runner';

/**
 * Registers the cron schedule of every job that declares one (`schedule = { cron, tz }`).
 *
 * `boss.schedule()` upserts a row in `pgboss.schedule` (written as `venueos_jobs`), so it is safe to run on
 * every start and on every worker instance. The queue itself already exists (created by a migration). The
 * payload is `{}`: a scheduled job never carries data. A schedule whose job was removed from the code is not
 * deleted here; remove it with `boss.unschedule` (docs/08, runbook).
 */
@Injectable()
export class ScheduleRegistrar implements OnApplicationBootstrap {
  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(JOBS) private readonly jobs: AnyJob[],
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.SCHEDULER_ENABLED) {
      this.logger.info('scheduler disabled (SCHEDULER_ENABLED=false), no schedules registered');
      return;
    }
    for (const job of this.jobs) {
      if (!job.schedule) continue;
      await this.pgBoss.boss.schedule(
        job.queue,
        job.schedule.cron,
        {},
        {
          tz: job.schedule.tz,
          // Occurrences missed while the worker was down are skipped: every scheduled job is a periodic
          // sweep, the next occurrence does the same work.
          missed: 'skip',
          retryLimit: JOB_RETRY.retryLimit,
          retryDelay: JOB_RETRY.retryDelaySeconds,
          retryBackoff: JOB_RETRY.retryBackoff,
          retryDelayMax: JOB_RETRY.retryDelayMaxSeconds,
          deadLetter: `${job.queue}.dead`,
        },
      );
      this.logger.info(
        { queue: job.queue, cron: job.schedule.cron, tz: job.schedule.tz },
        'job scheduled',
      );
    }
  }
}
