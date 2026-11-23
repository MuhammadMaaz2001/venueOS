import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config.module';

/**
 * Readiness probe for PostgreSQL: `SELECT 1` on a tiny dedicated pool. It touches no tenant data,
 * so it deliberately does not go through TenantDb (which requires a tenant context) and runs
 * without any `app.tenant_id` set. It is the only place outside packages/db that opens a connection.
 */
@Injectable()
export class DatabaseHealthService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseHealthService.name);
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      idleTimeoutMillis: 10_000,
    });
    // An idle client can fail (database restart); without a listener that would crash the process.
    this.pool.on('error', () => undefined);
  }

  async isUp(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      // Log the error code only: a driver message can contain the connection string.
      const code = (error as { code?: string }).code ?? 'UNKNOWN';
      this.logger.warn({ checkError: code }, 'Readiness: database check failed');
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
