import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { JobResult, JobWithMetadata } from 'pg-boss';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { LOGGER } from '../logging/logging.module';
import type { Logger } from '../logging/logging.module';
import { PgBossService } from '../queue/pg-boss.service';
import type { RegisteredJob } from './registered-job';

/** Injection token for the list of jobs this worker runs (see JobsModule). */
export const JOBS = Symbol('JOBS');

/** Anything the runner can register: tenant jobs, system jobs, scanners. */
export type AnyJob = RegisteredJob;

/** Registers every job with pg-boss once the queue is up. */
@Injectable()
export class JobRunner implements OnApplicationBootstrap {
  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(JOBS) private readonly jobs: AnyJob[],
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const job of this.jobs) {
      await this.pgBoss.boss.work(
        job.queue,
        {
          includeMetadata: true,
          perJobResults: true,
          batchSize: 1,
          localConcurrency: this.config.JOB_CONCURRENCY,
          pollingIntervalSeconds: this.config.JOB_POLLING_INTERVAL_SECONDS,
        },
        async (batch: JobWithMetadata<unknown>[]): Promise<JobResult[]> =>
          Promise.all(batch.map((item) => job.execute(item, this.logger))),
      );
      this.logger.info({ queue: job.queue }, 'job registered');
    }
  }
}
