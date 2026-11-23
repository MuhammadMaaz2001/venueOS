import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { contextModule } from './common/context/context.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { loggingModule } from './common/logging/logging.module';
import { CsrfGuard } from './common/security/csrf.guard';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { AppConfig } from './config/config.module';
import { HealthModule } from './health/health.module';
@Module({
  imports: [
    ConfigModule,
    contextModule,
    loggingModule,
    // In-memory, per API instance, keyed by client IP (req.ip, so TRUST_PROXY must be right).
    // Login/reset/invite limits live in the database (docs/04-security.md section 5).
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ ttl: config.THROTTLE_TTL_MS, limit: config.THROTTLE_LIMIT }],
      }),
    }),
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Guard order is registration order. Cheap checks first; P0-4 (AuthGuard) and P0-5 (TenantGuard,
    // PermissionGuard, EntitlementGuard) are added after CsrfGuard, never before it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
