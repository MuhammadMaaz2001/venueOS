import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';

/**
 * The one TenantDb of the worker (role `venueos_app`). Job handlers pass the tenant explicitly from the
 * job payload (`TenantDb.tx({ tenantId }, fn)`); there is no ambient request context here.
 */
@Global()
@Module({
  providers: [
    {
      provide: TenantDb,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new TenantDb({ connectionString: config.DATABASE_URL }),
    },
  ],
  exports: [TenantDb],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async onApplicationShutdown(): Promise<void> {
    await this.tenantDb.close();
  }
}
