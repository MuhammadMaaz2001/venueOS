// Runs the real seed script (prisma/seed.ts) against a throwaway migrated database.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { argon2Sync } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { adminUrl, createTestDatabase, dropTestDatabase, pkgDir, urlFor } from './helpers/test-db.mjs';

let admin: pg.Client; // maintenance connection (create/drop the database)
let su: pg.Client; // superuser connection INTO the test database: sees every row regardless of RLS
let dbName: string;

const PASSWORD = 'correct horse battery';

function runSeed(env: Record<string, string | undefined>) {
  const base: Record<string, string | undefined> = { ...process.env };
  // Never inherit the developer's own seed settings: each test states exactly what it wants.
  for (const k of ['SEED_OWNER_EMAIL', 'SEED_OWNER_PASSWORD', 'NODE_ENV']) delete base[k];
  const res = spawnSync(process.execPath, ['--import', 'tsx', path.join(pkgDir, 'prisma', 'seed.ts')], {
    cwd: pkgDir,
    encoding: 'utf8',
    env: {
      ...base,
      // The seed calls dotenv/config; keep it from re-reading the developer's packages/db/.env.
      DOTENV_CONFIG_PATH: path.join(pkgDir, '.env.does-not-exist'),
      MIGRATE_DATABASE_URL: urlFor('venueos_migrator', dbName),
      ...env,
    },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const count = async (table: string) =>
  Number((await su.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

before(async () => {
  ({ admin, dbName } = await createTestDatabase());
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  su = new pg.Client({ connectionString: u.toString() });
  await su.connect();
});
after(async () => {
  await su?.end();
  await dropTestDatabase(admin, dbName);
});

describe('prisma/seed.ts', () => {
  test('refuses to seed the demo owner when SEED_OWNER_* is missing, and writes nothing', () => {
    const res = runSeed({});
    assert.equal(res.code, 1);
    assert.match(res.out, /SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD/);
    const res2 = runSeed({ SEED_OWNER_EMAIL: 'owner@example.test' });
    assert.equal(res2.code, 1);
    const res3 = runSeed({ SEED_OWNER_EMAIL: 'owner@example.test', SEED_OWNER_PASSWORD: 'short' });
    assert.equal(res3.code, 1);
    assert.match(res3.out, /at least 12/);
  });

  test('NODE_ENV=production seeds the plans only', async () => {
    const res = runSeed({
      NODE_ENV: 'production',
      SEED_OWNER_EMAIL: 'owner@example.test',
      SEED_OWNER_PASSWORD: PASSWORD,
    });
    assert.equal(res.code, 0, res.out);
    assert.equal(await count('plans'), 3);
    assert.equal(await count('tenants'), 0);
    assert.equal(await count('users'), 0);
  });

  test('seeds the demo tenant, and a second and third run change nothing', async () => {
    const env = { SEED_OWNER_EMAIL: 'owner@example.test', SEED_OWNER_PASSWORD: PASSWORD };
    for (let i = 0; i < 3; i++) {
      const res = runSeed(env);
      assert.equal(res.code, 0, res.out);
    }
    const expected: Record<string, number> = {
      plans: 3,
      tenants: 1,
      subscriptions: 1,
      users: 1,
      user_credentials: 1,
      roles: 1,
      memberships: 1,
      venues: 1,
      spaces: 4,
      space_components: 2,
      slot_templates: 2,
    };
    for (const [table, n] of Object.entries(expected)) {
      assert.equal(await count(table), n, table);
    }

    const { rows } = await su.query(
      `SELECT r.id, r.permissions, r.is_system, m.user_id
         FROM roles r JOIN memberships m ON m.role_id = r.id`,
    );
    assert.deepEqual(rows, [
      { id: 'seed_role_owner', permissions: [], is_system: true, user_id: 'seed_user_owner' },
    ]);
  });

  test('stores a verifiable argon2id hash, never the plain password', async () => {
    const { rows } = await su.query(`SELECT password_hash FROM user_credentials`);
    const phc: string = rows[0].password_hash;
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(phc);
    assert.ok(m, `not a PHC argon2id string: ${phc.slice(0, 20)}`);
    const [, memory, passes, parallelism, salt, hash] = m;
    const again = argon2Sync('argon2id', {
      message: PASSWORD,
      nonce: Buffer.from(salt as string, 'base64'),
      memory: Number(memory),
      passes: Number(passes),
      parallelism: Number(parallelism),
      tagLength: 32,
    });
    assert.equal(again.toString('base64').replace(/=+$/, ''), hash);
    assert.ok(!phc.includes(PASSWORD));
  });

  test('a re-run does not overwrite edits (Owner role permissions survive)', async () => {
    await su.query(`UPDATE roles SET permissions = ARRAY['booking.create'] WHERE id = 'seed_role_owner'`);
    const res = runSeed({ SEED_OWNER_EMAIL: 'owner@example.test', SEED_OWNER_PASSWORD: PASSWORD });
    assert.equal(res.code, 0, res.out);
    const { rows } = await su.query(`SELECT permissions FROM roles WHERE id = 'seed_role_owner'`);
    assert.deepEqual(rows[0].permissions, ['booking.create']);
  });
});
