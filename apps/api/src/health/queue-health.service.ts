import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { expectedPgBossSchemaVersion } from '@venueos/db';
import { JOB_NAMES } from '@venueos/shared';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config.module';

/**
 * Readiness probe for the job queue: the `pgboss` schema is installed at the version this build expects
 * and the queues exist. A missing or older schema (migrations not run) or a library upgrade without its
 * migration means jobs would fail to enqueue, so the instance reports itself unready. It reads only
 * `pgboss.version` and `pgboss.queue` (no tenant data), on a tiny dedicated pool like the database check.
 */
@Injectable()
export class QueueHealthService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly expectedVersion = expectedPgBossSchemaVersion();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueHealthService.name);
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
      const { rows } = await this.pool.query<{ version: number | null; queues: string }>(
        `SELECT (SELECT max(version) FROM pgboss.version) AS version,
                (SELECT count(*) FROM pgboss.queue WHERE name = ANY($1::text[])) AS queues`,
        [[JOB_NAMES.EMAIL_SEND, JOB_NAMES.EMAIL_SEND_DEAD]],
      );
      const row = rows[0];
      const up = row?.version === this.expectedVersion && Number(row.queues) === 2;
      if (!up) {
        this.logger.warn(
          { installedVersion: row?.version ?? null, expectedVersion: this.expectedVersion },
          'Readiness: the job queue schema is missing, outdated or incomplete',
        );
      }
      return up;
    } catch (error) {
      // Log the error code only: a driver message can contain the connection string.
      const code = (error as { code?: string }).code ?? 'UNKNOWN';
      this.logger.warn({ checkError: code }, 'Readiness: job queue check failed');
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
