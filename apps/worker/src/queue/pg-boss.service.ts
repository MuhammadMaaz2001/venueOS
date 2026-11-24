import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PGBOSS_SCHEMA, expectedPgBossSchemaVersion } from '@venueos/db';
import { PgBoss } from 'pg-boss';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { LOGGER } from '../logging/logging.module';
import type { Logger } from '../logging/logging.module';

/**
 * The worker's pg-boss instance, connected as `venueos_jobs` (read/write on the `pgboss` schema only).
 * The schema is created by the migrator: this service never creates or migrates it (`migrate: false`,
 * `createSchema: false`) and refuses to start when the installed library expects another version.
 * Cron schedules are registered by `ScheduleRegistrar` from the jobs that declare a `schedule`.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnApplicationShutdown {
  readonly boss: PgBoss;

  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.boss = new PgBoss({
      connectionString: config.JOBS_DATABASE_URL,
      schema: PGBOSS_SCHEMA,
      application_name: 'venueos-worker',
      max: Math.max(config.JOB_CONCURRENCY + 2, 5),
      migrate: false,
      createSchema: false,
      supervise: true,
      // Cron firing is on unless SCHEDULER_ENABLED=false. Any number of workers can run it: pg-boss takes
      // a lock, so each occurrence is sent once.
      schedule: config.SCHEDULER_ENABLED,
    });
    // Driver messages can contain connection details: log the error name and code only.
    this.boss.on('error', (error: Error & { code?: string }) => {
      this.logger.error({ errorName: error.name, errorCode: error.code }, 'pg-boss error');
    });
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    const installed = await this.boss.schemaVersion();
    const expected = expectedPgBossSchemaVersion();
    if (installed !== expected) {
      await this.boss.stop({ graceful: false });
      throw new Error(
        `pgboss schema version is ${String(installed)}, this build needs ${expected}: run the database migrations`,
      );
    }
    this.logger.info({ schemaVersion: installed }, 'pg-boss started');
  }

  async onApplicationShutdown(): Promise<void> {
    // Graceful: running jobs finish (or time out) before the pool closes.
    await this.boss.stop({ graceful: true, timeout: 15_000 });
    this.logger.info('pg-boss stopped');
  }
}
