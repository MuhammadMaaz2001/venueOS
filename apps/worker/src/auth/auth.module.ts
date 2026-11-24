import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { AuthDb } from '@venueos/db';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { AuthPurgeJob } from './auth-purge.job';

/**
 * The worker's only `AuthDb` (role `venueos_auth`), used by `auth.purge` alone. It is NOT exported: no other
 * provider can inject it (apps/worker/CLAUDE.md).
 */
@Module({
  providers: [
    {
      provide: AuthDb,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) =>
        new AuthDb({ connectionString: config.AUTH_DATABASE_URL, poolMax: 3 }),
    },
    {
      provide: AuthPurgeJob,
      inject: [AuthDb],
      useFactory: (authDb: AuthDb) => new AuthPurgeJob(authDb),
    },
  ],
  exports: [AuthPurgeJob],
})
export class AuthPurgeModule implements OnApplicationShutdown {
  constructor(@Inject(AuthDb) private readonly authDb: AuthDb) {}

  async onApplicationShutdown(): Promise<void> {
    await this.authDb.close();
  }
}
