// Vitest global setup: one throwaway, fully migrated Postgres database for the whole worker test run.
//
// Same prerequisites as `pnpm --filter @venueos/db test:constraints` (docker Postgres that ran the role
// script, VENUEOS_TEST_ADMIN_URL read from packages/db/.env when not already set), plus Mailpit
// (docker compose up -d mailpit: SMTP on :1025, HTTP API on :8025) for the delivery tests.
//
// The code under test connects as venueos_app (tenant work) and venueos_jobs (the pg-boss connection),
// so RLS and grants apply for real.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let admin;
let dbName;
let dropTestDatabase;

export async function setup() {
  if (!process.env.VENUEOS_TEST_ADMIN_URL) {
    try {
      process.loadEnvFile(path.join(here, '..', '..', '..', 'packages', 'db', '.env'));
    } catch {
      // no packages/db/.env: the helper falls back to its documented default URL
    }
  }
  // test-db.mjs reads its URL at import time, so import it after the env is ready.
  const helpers = await import('../../../packages/db/tests/helpers/test-db.mjs');
  const { createTestDatabase, urlFor } = helpers;
  ({ dropTestDatabase } = helpers);
  ({ admin, dbName } = await createTestDatabase());

  process.env.DATABASE_URL = urlFor('venueos_app', dbName);
  process.env.JOBS_DATABASE_URL = urlFor('venueos_jobs', dbName);
  // Admin URL of the throwaway database (migrator), for assertions on pgboss.* from the tests.
  process.env.VENUEOS_TEST_MIGRATOR_URL = urlFor('venueos_migrator', dbName);
}

export async function teardown() {
  await dropTestDatabase(admin, dbName);
}
