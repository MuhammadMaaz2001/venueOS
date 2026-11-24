import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { DeadLetterCheckJob } from './dead-letter-check.job';

const OPS_POOL = Symbol('OPS_POOL');

/** Operational jobs that read the queue itself (role `venueos_jobs`, `pgboss` schema only). */
@Module({
  providers: [
    {
      provide: OPS_POOL,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => {
        const pool = new pg.Pool({
          connectionString: config.JOBS_DATABASE_URL,
          max: 1,
          application_name: 'venueos-worker-ops',
        });
        pool.on('error', () => undefined);
        return pool;
      },
    },
    {
      provide: DeadLetterCheckJob,
      inject: [OPS_POOL],
      useFactory: (pool: pg.Pool) => new DeadLetterCheckJob(pool),
    },
  ],
  exports: [DeadLetterCheckJob],
})
export class OpsModule implements OnApplicationShutdown {
  constructor(@Inject(OPS_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
