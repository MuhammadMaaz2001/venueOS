import { getConstructionPlans } from 'pg-boss';
import { PGBOSS_SCHEMA } from './job-queue.js';

/**
 * The pg-boss schema version the pinned library expects (47 for pg-boss 12.39.0). The migration that
 * installs the schema is generated from the same library, so `pgboss.version` must equal this number;
 * the readiness check and a test compare them, which catches a library bump without a migration.
 */
export function expectedPgBossSchemaVersion(): number {
  const sql = getConstructionPlans(PGBOSS_SCHEMA);
  const match = /INSERT INTO pgboss\.version\(version\) VALUES \('(\d+)'\)/.exec(sql);
  if (!match?.[1]) throw new Error('Cannot determine the pg-boss schema version from the library');
  return Number(match[1]);
}
