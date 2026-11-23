import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { ClsService } from 'nestjs-cls';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import type { RequestContext } from '../context/request-context';

/**
 * The one TenantDb of the API (role `venueos_app`). `tx(fn)` without a context argument takes the
 * ambient one from CLS: tenant and user set by the guards, never by the request body.
 */
@Global()
@Module({
  providers: [
    {
      provide: TenantDb,
      inject: [APP_CONFIG, ClsService],
      useFactory: (config: AppConfig, cls: ClsService<RequestContext>) =>
        new TenantDb({
          connectionString: config.DATABASE_URL,
          getContext: () => ({ tenantId: cls.get('tenantId'), userId: cls.get('userId') }),
        }),
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
