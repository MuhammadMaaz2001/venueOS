// Vitest global setup: one throwaway, fully migrated Postgres database for the whole API test run.
//
// It reuses the helpers of packages/db (same migrations as production, built as the non-superuser
// migrator) and needs what `pnpm --filter @venueos/db test:constraints` needs: a Postgres cluster that
// ran the role script (docker compose up -d postgres) and VENUEOS_TEST_ADMIN_URL (read from
// packages/db/.env when not already set, e.g. by CI). Tests create their own tenants (see
// src/__tests__/helpers/world.ts); nothing depends on seed data except the platform plans, which the
// app role cannot write and which are inserted here.
//
// The app under test gets DATABASE_URL = venueos_app on that database, so RLS and grants apply for real.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

const PLANS = [
  [
    'starter',
    'Starter',
    { maxVenues: 1, maxSpaces: 3, maxUsers: 5, emailsPerMonth: 2000, customDomain: false },
  ],
  [
    'growth',
    'Growth',
    { maxVenues: 3, maxSpaces: 15, maxUsers: 20, emailsPerMonth: 10000, customDomain: true },
  ],
  [
    'enterprise',
    'Enterprise',
    { maxVenues: 50, maxSpaces: 500, maxUsers: 200, emailsPerMonth: 100000, customDomain: true },
  ],
];

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

  const migrator = new pg.Client({ connectionString: urlFor('venueos_migrator', dbName) });
  await migrator.connect();
  try {
    for (const [code, name, entitlements] of PLANS) {
      await migrator.query(
        `INSERT INTO plans (id, code, name, entitlements, price_monthly, currency, updated_at)
         VALUES ($1, $2, $3, $4, 0, 'PKR', now())`,
        [`plan_${code}`, code, name, JSON.stringify(entitlements)],
      );
    }
  } finally {
    await migrator.end();
  }

  process.env.DATABASE_URL = urlFor('venueos_app', dbName);
  // The AuthModule's connection (sessions, credentials, tokens, invitations): role venueos_auth.
  process.env.AUTH_DATABASE_URL = urlFor('venueos_auth', dbName);
  // The cluster superuser on the test database (bypasses RLS): tests read message_logs of tenants they
  // cannot name in advance (a signup creates its own). Assertions only; the code under test never uses it.
  const superuser = new URL(helpers.adminUrl);
  superuser.pathname = `/${dbName}`;
  process.env.VENUEOS_TEST_SUPERUSER_URL = superuser.toString();
}

export async function teardown() {
  await dropTestDatabase(admin, dbName);
}
