import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { AccessModule } from './common/access/access.module';
import { AuthGuard } from './common/access/auth.guard';
import { EntitlementGuard } from './common/access/entitlement.guard';
import { PermissionGuard } from './common/access/permission.guard';
import { TenantGuard } from './common/access/tenant.guard';
import { AuditModule } from './common/audit/audit.module';
import { contextModule } from './common/context/context.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { DbModule } from './common/db/db.module';
import { JobsModule } from './common/jobs/jobs.module';
import { loggingModule } from './common/logging/logging.module';
import { CsrfGuard } from './common/security/csrf.guard';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { AppConfig } from './config/config.module';
import { HealthModule } from './health/health.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EventTypesModule } from './modules/event-types/event-types.module';
import { LeadsModule } from './modules/leads/leads.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RolesModule } from './modules/roles/roles.module';
import { SlotTemplatesModule } from './modules/slot-templates/slot-templates.module';
import { SpacesModule } from './modules/spaces/spaces.module';
import { StaffModule } from './modules/staff/staff.module';
import { TenantSettingsModule } from './modules/tenant-settings/tenant-settings.module';
import { VenuesModule } from './modules/venues/venues.module';
@Module({
  imports: [
    ConfigModule,
    contextModule,
    loggingModule,
    DbModule,
    JobsModule,
    AccessModule,
    AuditModule,
    // In-memory, per API instance, keyed by client IP (req.ip, so TRUST_PROXY must be right).
    // Login/reset/invite limits live in the database (docs/04-security.md section 5).
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ ttl: config.THROTTLE_TTL_MS, limit: config.THROTTLE_LIMIT }],
      }),
    }),
    HealthModule,
    AuthModule,
    RolesModule,
    AuditLogsModule,
    StaffModule,
    TenantSettingsModule,
    VenuesModule,
    SpacesModule,
    SlotTemplatesModule,
    EventTypesModule,
    CatalogueModule,
    PricingModule,
    CustomersModule,
    LeadsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Guard order is registration order and follows docs/02-system-design.md (request lifecycle):
    // throttler, CSRF, auth, tenant, permission, entitlement. Never reorder; add new guards in place.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: EntitlementGuard },
  ],
})
export class AppModule {}
