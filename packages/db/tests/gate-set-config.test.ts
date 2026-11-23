// P0-2 GATE. Must pass before TenantDb is built (docs/09-phase-0-plan.md, docs/03-data-model.md).
//
// Question: with the Prisma 7 `pg` driver adapter, connected as venueos_app (no BYPASSRLS),
// does `set_config('app.tenant_id', <id>, true)` stay visible to the following statements of ONE
// `prisma.$transaction(async tx => ...)`, and does it vanish at the end of that transaction?
//
//   (a) inside the transaction current_setting returns t1 and tenant-1 rows are selectable
//   (b) tenant 2's rows are invisible and a write for tenant 2 is rejected, in the SAME transaction
//   (c) after commit, the next transaction on the (pooled) connection sees no tenant
//   (d) the same after a ROLLBACK
//
// The pool is limited to ONE connection so (c) and (d) are guaranteed to reuse the connection that
// carried the tenant context; pg_backend_pid() asserts it.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestDatabase, dropTestDatabase, seedAs, urlFor } from './helpers/test-db.mjs';

let admin: pg.Client;
let dbName: string;
let prisma: PrismaClient;

const currentTenant = (tx: Pick<PrismaClient, '$queryRaw'>) =>
  tx.$queryRaw<{ tenant: string | null; pid: number }[]>`
    SELECT current_setting('app.tenant_id', true) AS tenant, pg_backend_pid() AS pid`;

before(async () => {
  ({ admin, dbName } = await createTestDatabase());
  // Fixtures through plain pg as venueos_app, with the context set the way TenantDb does it.
  await seedAs(
    'venueos_app',
    dbName,
    { tenant: 't1' },
    `INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
       VALUES ('t1','one','One','PK','PKR','Asia/Karachi','ACTIVE');
     INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v1','t1','Venue One','{}');`,
  );
  await seedAs(
    'venueos_app',
    dbName,
    { tenant: 't2' },
    `INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
       VALUES ('t2','two','Two','PK','PKR','Asia/Karachi','ACTIVE');
     INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v2','t2','Venue Two','{}');`,
  );

  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor('venueos_app', dbName), max: 1 }),
  });
});

after(async () => {
  await prisma?.$disconnect();
  await dropTestDatabase(admin, dbName);
});

describe('set_config(app.tenant_id, ..., true) inside prisma.$transaction via the pg adapter', () => {
  let pidInTx: number;

  test('(a) the setting is visible to later statements and tenant-1 rows are selectable', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${'t1'}, true)`;

      const [row] = await currentTenant(tx);
      assert.equal(row?.tenant, 't1');
      pidInTx = Number(row?.pid);

      // Prisma model API (not just raw SQL) must see the context too.
      const venues = await tx.venue.findMany({ select: { id: true } });
      assert.deepEqual(venues.map((v) => v.id), ['v1']);

      // A write for the active tenant is accepted.
      const created = await tx.venue.create({
        data: { id: 'v1-extra', tenantId: 't1', name: 'Extra', photoKeys: [] },
      });
      assert.equal(created.tenantId, 't1');
      await tx.venue.delete({ where: { id: 'v1-extra' } });
    });
  });

  test("(b) tenant 2's rows are invisible and a write for tenant 2 is rejected in the same transaction", async () => {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${'t1'}, true)`;

        assert.equal(await tx.venue.findUnique({ where: { id: 'v2' } }), null);
        assert.equal(await tx.venue.count({ where: { tenantId: 't2' } }), 0);
        assert.equal(await tx.tenant.findUnique({ where: { id: 't2' } }), null);

        // Reads above passed; now the cross-tenant write must fail (RLS WITH CHECK).
        await tx.venue.create({
          data: { id: 'v2-evil', tenantId: 't2', name: 'Evil', photoKeys: [] },
        });
      }),
      (e: Error) => /row-level security/i.test(e.message),
    );

    // Updating tenant 2's row from tenant 1's context matches no rows.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${'t1'}, true)`;
      const res = await tx.venue.updateMany({ where: { id: 'v2' }, data: { name: 'hijacked' } });
      assert.equal(res.count, 0);
    });
  });

  test('(c) after commit the next transaction on the same pooled connection sees no tenant', async () => {
    await prisma.$transaction(async (tx) => {
      const [row] = await currentTenant(tx);
      assert.equal(Number(row?.pid), pidInTx, 'must be the same pooled connection');
      assert.ok(row?.tenant === null || row?.tenant === '', `leaked tenant: ${row?.tenant}`);
      assert.equal(await tx.venue.count(), 0);
      assert.equal(await tx.tenant.count(), 0);
    });

    // And outside any explicit transaction.
    assert.equal(await prisma.venue.count(), 0);
  });

  test('(d) after a rolled-back transaction the context is gone too', async () => {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${'t2'}, true)`;
        assert.equal(await tx.venue.count(), 1);
        throw new Error('boom');
      }),
      /boom/,
    );

    const [row] = await currentTenant(prisma);
    assert.equal(Number(row?.pid), pidInTx);
    assert.ok(row?.tenant === null || row?.tenant === '', `leaked tenant: ${row?.tenant}`);
    assert.equal(await prisma.venue.count(), 0);
  });
});
