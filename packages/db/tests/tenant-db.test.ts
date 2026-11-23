// Integration tests for TenantDb, AuthDb and the pg-boss adapter against a real, migrated schema
// (throwaway database, roles venueos_app / venueos_auth). Run: pnpm --filter @venueos/db test

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthDb, TenantDb, pgBossDb } from '../src/index.js';
import {
  createTestDatabase,
  dropTestDatabase,
  seedAs,
  urlFor,
} from './helpers/test-db.mjs';
import type pg from 'pg';

let admin: pg.Client;
let dbName: string;
let tenantDb: TenantDb;
let authDb: AuthDb;
let ambient: { tenantId?: string; userId?: string } | undefined;

before(async () => {
  ({ admin, dbName } = await createTestDatabase());

  await seedAs(
    'venueos_auth',
    dbName,
    {},
    `INSERT INTO users (id, name, email) VALUES ('u1','User One','u1@example.test'),('u2','User Two','u2@example.test')`,
  );
  await seedAs(
    'venueos_app',
    dbName,
    { tenant: 't1' },
    `INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
       VALUES ('t1','one','One','PK','PKR','Asia/Karachi','ACTIVE');
     INSERT INTO roles (id, tenant_id, name, permissions) VALUES ('r1','t1','Owner','{}');
     INSERT INTO memberships (id, tenant_id, user_id, role_id, venue_ids) VALUES ('m1','t1','u1','r1','{}');
     INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v1','t1','Venue One','{}');`,
  );
  await seedAs(
    'venueos_app',
    dbName,
    { tenant: 't2' },
    `INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
       VALUES ('t2','two','Two','PK','PKR','Asia/Karachi','ACTIVE');
     INSERT INTO roles (id, tenant_id, name, permissions) VALUES ('r2','t2','Owner','{}');
     INSERT INTO memberships (id, tenant_id, user_id, role_id, venue_ids)
       VALUES ('m2','t2','u1','r2','{}'),('m3','t2','u2','r2','{}');
     INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v2','t2','Venue Two','{}');`,
  );

  tenantDb = new TenantDb({
    connectionString: urlFor('venueos_app', dbName),
    poolMax: 5,
    getContext: () => ambient,
  });
  authDb = new AuthDb({ connectionString: urlFor('venueos_auth', dbName), poolMax: 2 });
});

after(async () => {
  await tenantDb?.close();
  await authDb?.close();
  await dropTestDatabase(admin, dbName);
});

describe('TenantDb.tx', () => {
  test('scopes reads and writes to the tenant and sets app.user_id', async () => {
    await tenantDb.tx({ tenantId: 't1', userId: 'u1' }, async (tx) => {
      const [ctx] = await tx.$queryRaw<{ tenant: string; user: string }[]>`
        SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.user_id', true) AS "user"`;
      assert.deepEqual(ctx, { tenant: 't1', user: 'u1' });

      assert.deepEqual((await tx.venue.findMany({ select: { id: true } })).map((v) => v.id), ['v1']);
      assert.equal(await tx.venue.findUnique({ where: { id: 'v2' } }), null);

      await assert.rejects(
        tx.venue.create({ data: { tenantId: 't2', name: 'nope', photoKeys: [] } }),
        /row-level security/i,
      );
    });
  });

  test('the one-argument form takes the context from getContext', async () => {
    ambient = { tenantId: 't2', userId: 'u2' };
    const ids = await tenantDb.tx(async (tx) => (await tx.venue.findMany()).map((v) => v.id));
    assert.deepEqual(ids, ['v2']);
  });

  test('refuses to run without a tenant or with a malformed id', async () => {
    ambient = undefined;
    await assert.rejects(tenantDb.tx(async () => 1), /tenantId is missing/);
    ambient = { userId: 'u1' };
    await assert.rejects(tenantDb.tx(async () => 1), /tenantId is missing/);
    await assert.rejects(tenantDb.tx({ tenantId: '' }, async () => 1), /tenantId is missing/);
    await assert.rejects(tenantDb.tx({ tenantId: "t1'; --" }, async () => 1), /malformed/);
    await assert.rejects(tenantDb.tx({ tenantId: 't1', userId: 'bad id' }, async () => 1), /userId/);
  });

  test('rolls back everything when the callback throws', async () => {
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, async (tx) => {
        await tx.venue.create({ data: { id: 'v-rollback', tenantId: 't1', name: 'x', photoKeys: [] } });
        throw new Error('boom');
      }),
      /boom/,
    );
    const found = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      tx.venue.findUnique({ where: { id: 'v-rollback' } }),
    );
    assert.equal(found, null);
  });

  test('concurrent transactions for different tenants never see each other', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const tenantId = i % 2 === 0 ? 't1' : 't2';
        return tenantDb.tx({ tenantId }, async (tx) => {
          await tx.$queryRaw`SELECT pg_sleep(0.01)::text AS slept`;
          const venues = await tx.venue.findMany({ select: { tenantId: true } });
          return { tenantId, seen: new Set(venues.map((v) => v.tenantId)) };
        });
      }),
    );
    for (const r of results) assert.deepEqual([...r.seen], [r.tenantId]);
  });

  test('the tenant role cannot read the auth tables', async () => {
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) => tx.userCredential.findMany()),
      /permission denied/i,
    );
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) => tx.authSession.findMany()),
      /permission denied/i,
    );
  });
});

describe('TenantDb.asUser (pre-tenant context)', () => {
  test('shows only the user’s own memberships and tenants', async () => {
    const seen = await tenantDb.asUser('u1', async (tx) => ({
      memberships: (await tx.membership.findMany({ select: { id: true } })).map((m) => m.id).sort(),
      tenants: (await tx.tenant.findMany({ select: { id: true } })).map((t) => t.id).sort(),
      venues: await tx.venue.count(),
    }));
    assert.deepEqual(seen, { memberships: ['m1', 'm2'], tenants: ['t1', 't2'], venues: 0 });

    const other = await tenantDb.asUser('u2', async (tx) => ({
      memberships: (await tx.membership.findMany({ select: { id: true } })).map((m) => m.id),
      tenants: (await tx.tenant.findMany({ select: { id: true } })).map((t) => t.id),
    }));
    assert.deepEqual(other, { memberships: ['m3'], tenants: ['t2'] });
  });

  test('takes the user from getContext in the one-argument form and validates it', async () => {
    ambient = { userId: 'u2' };
    assert.equal(await tenantDb.asUser((tx) => tx.membership.count()), 1);
    ambient = {};
    await assert.rejects(tenantDb.asUser(async () => 1), /userId is missing/);
  });
});

describe('AuthDb', () => {
  test('reads and writes the auth tables and rolls back atomically', async () => {
    await authDb.client.userCredential.create({ data: { userId: 'u1', passwordHash: 'hash' } });
    const cred = await authDb.client.userCredential.findUnique({ where: { userId: 'u1' } });
    assert.equal(cred?.passwordHash, 'hash');

    await assert.rejects(
      authDb.tx(async (tx) => {
        await tx.authToken.create({
          data: { userId: 'u2', tokenHash: 'h1', purpose: 'EMAIL_VERIFY', expiresAt: new Date(Date.now() + 60_000) },
        });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await authDb.client.authToken.count({ where: { tokenHash: 'h1' } }), 0);
  });

  test('can manage users but has no access to tenant tables', async () => {
    assert.equal(await authDb.client.user.count(), 2);
    await assert.rejects(authDb.client.venue.findMany(), /permission denied/i);
  });
});

describe('pgBossDb adapter', () => {
  test('runs bound-parameter SQL on the transaction and returns { rows }', async () => {
    const rows = await tenantDb.tx({ tenantId: 't1' }, async (tx) => {
      const res = await pgBossDb(tx).executeSql('SELECT id, name FROM venues WHERE id = $1', ['v1']);
      return res.rows;
    });
    assert.deepEqual(rows, [{ id: 'v1', name: 'Venue One' }]);
  });

  test('its writes commit and roll back with the surrounding transaction', async () => {
    const insert = (tx: Parameters<typeof pgBossDb>[0], id: string) =>
      pgBossDb(tx).executeSql(
        'INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ($1, $2, $3, $4) RETURNING id',
        [id, 't1', 'Queued', []],
      );

    await tenantDb.tx({ tenantId: 't1' }, (tx) => insert(tx, 'v-queued-ok'));
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, async (tx) => {
        await insert(tx, 'v-queued-lost');
        throw new Error('boom');
      }),
      /boom/,
    );

    const ids = await tenantDb.tx({ tenantId: 't1' }, async (tx) =>
      (await tx.venue.findMany({ select: { id: true } })).map((v) => v.id).sort(),
    );
    assert.deepEqual(ids, ['v-queued-ok', 'v1']);
  });

  test('is still subject to RLS (runs inside the tenant transaction)', async () => {
    const rows = await tenantDb.tx({ tenantId: 't1' }, async (tx) =>
      (await pgBossDb(tx).executeSql('SELECT id FROM venues WHERE tenant_id = $1', ['t2'])).rows,
    );
    assert.deepEqual(rows, []);
  });
});
