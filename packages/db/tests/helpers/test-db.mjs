// Shared helpers for the database tests (constraint tests, tenant-context gate, TenantDb tests).
//
// Needs a Postgres 16 cluster that already ran packages/db/docker/init-roles.sql (roles) and a
// superuser URL to create a throwaway database:
//   docker compose up -d postgres
//   VENUEOS_TEST_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres   (default)
// Role passwords default to the local placeholders in init-roles.sql; override with
//   VENUEOS_TEST_MIGRATOR_PASSWORD / _APP_PASSWORD / _AUTH_PASSWORD / _JOBS_PASSWORD.
//
// Schema source: once prisma/migrations/* exist, those migration.sql files are applied in order
// (exactly what `prisma migrate deploy` does). Before that, the DDL is generated with
// `prisma migrate diff --from-empty --to-schema` and 001_constraints_and_rls.sql is appended,
// which is what the first migration contains. PRISMA_CMD overrides how prisma is invoked
// (default `pnpm exec prisma`), PRISMA_CWD where it runs (default: this package).

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pkgDir = path.resolve(here, '..', '..');

export const adminUrl =
  process.env.VENUEOS_TEST_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

const passwords = {
  venueos_migrator: process.env.VENUEOS_TEST_MIGRATOR_PASSWORD ?? 'migrator_password',
  venueos_app: process.env.VENUEOS_TEST_APP_PASSWORD ?? 'app_password',
  venueos_auth: process.env.VENUEOS_TEST_AUTH_PASSWORD ?? 'auth_password',
  venueos_jobs: process.env.VENUEOS_TEST_JOBS_PASSWORD ?? 'jobs_password',
};

export const newDbName = () => `venueos_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

/** Connection URL for `user` (one of the venueos_* roles) against `database`. */
export const urlFor = (user, database) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = passwords[user];
  u.pathname = `/${database}`;
  return u.toString();
};

export function buildSchemaSql() {
  const migDir = path.join(pkgDir, 'prisma', 'migrations');
  const migrations = fs.existsSync(migDir)
    ? fs
        .readdirSync(migDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  if (migrations.length > 0) {
    return migrations
      .map((m) => fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8'))
      .join('\n');
  }
  const prisma = process.env.PRISMA_CMD ?? 'pnpm exec prisma';
  const schema = path.join(pkgDir, 'prisma', 'schema.prisma');
  const ddl = execSync(`${prisma} migrate diff --from-empty --to-schema "${schema}" --script`, {
    cwd: process.env.PRISMA_CWD ?? pkgDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (
    ddl + '\n' + fs.readFileSync(path.join(pkgDir, 'prisma', 'sql', '001_constraints_and_rls.sql'), 'utf8')
  );
}

/**
 * CREATE DATABASE (owned by venueos_migrator) and build the schema as the NON-superuser
 * migrator, so the migration is proven to work in staging/production too.
 * Returns the admin client (keep it open until dropTestDatabase) and the database name.
 */
export async function createTestDatabase() {
  const dbName = newDbName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}" OWNER venueos_migrator`);
  const migrator = new pg.Client({ connectionString: urlFor('venueos_migrator', dbName) });
  await migrator.connect();
  try {
    await migrator.query(buildSchemaSql());
  } finally {
    await migrator.end();
  }
  return { admin, dbName };
}

/**
 * Run `sql` as `role` in ONE transaction with app.tenant_id (and optionally app.user_id) set, the
 * way TenantDb does it. For fixtures only; the code under test never uses this.
 */
export async function seedAs(role, dbName, { tenant, user }, sql) {
  const c = new pg.Client({ connectionString: urlFor(role, dbName) });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    if (user) await c.query("SELECT set_config('app.user_id', $1, true)", [user]);
    await c.query(sql);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

export async function dropTestDatabase(admin, dbName) {
  if (!admin) return;
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
