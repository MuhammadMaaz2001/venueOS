import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../common/audit/audit.service';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { authHeader } from './helpers/test-auth';
import { World } from './helpers/world';

describe('AuditService', () => {
  let t: TestApp;
  let world: World;
  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const audit = () => t.app.get(AuditService);
  const cls = () => t.app.get(ClsService);

  it('writes a USER row in the request transaction, with actor, tenant, ip and masked fields', async () => {
    const tenant = await world.createTenant();
    const m = await world.addMember(tenant, { role: { permissions: ['audit.view'] } });
    const res = await t
      .http()
      .post('/v1/_access/audit/commit')
      .set(t.as(authHeader(m.userId, tenant.id)));
    expect(res.status).toBe(201);

    const rows = await world.auditRows(tenant, { action: 'probe.commit' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant.id,
      actorType: 'USER',
      actorUserId: m.userId,
      entityType: 'probe',
      entityId: 'probe_1',
      before: null,
      after: { mode: 'commit', password: '[REDACTED]' },
    });
    expect(rows[0]?.ip).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it('rolls the audit row back together with the transaction that failed', async () => {
    const tenant = await world.createTenant();
    const m = await world.addMember(tenant, { role: { permissions: ['audit.view'] } });
    const res = await t
      .http()
      .post('/v1/_access/audit/rollback')
      .set(t.as(authHeader(m.userId, tenant.id)));
    expect(res.status).toBe(500);
    expect(await world.auditRows(tenant, { action: 'probe.rollback' })).toHaveLength(0);
  });

  it('writes a SYSTEM row without an actor, for an explicit tenant, outside any request', async () => {
    const tenant = await world.createTenant();
    await world.db.tx({ tenantId: tenant.id }, (tx) =>
      audit().record(tx, {
        actor: 'SYSTEM',
        tenantId: tenant.id,
        action: 'holds.expire',
        entityType: 'booking',
        entityId: 'bk_1',
        before: { status: 'TENTATIVE' },
        after: { status: 'EXPIRED' },
      }),
    );
    const rows = await world.auditRows(tenant, { action: 'holds.expire' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorUserId: null,
      ip: null,
      before: { status: 'TENTATIVE' },
      after: { status: 'EXPIRED' },
    });
  });

  it('refuses a SYSTEM entry without a tenant and a USER entry without a user', async () => {
    const tenant = await world.createTenant();
    await expect(
      world.db.tx({ tenantId: tenant.id }, (tx) =>
        audit().record(tx, { actor: 'SYSTEM', action: 'x', entityType: 'x', entityId: 'x' }),
      ),
    ).rejects.toThrow(/tenant/);

    await expect(
      cls().run(async () => {
        cls().set('tenantId', tenant.id);
        await world.db.tx({ tenantId: tenant.id }, (tx) =>
          audit().record(tx, { action: 'x', entityType: 'x', entityId: 'x' }),
        );
      }),
    ).rejects.toThrow(/authenticated user/);
    expect(await world.auditRows(tenant)).toHaveLength(0);
  });

  it("cannot write a row into another tenant's log (row level security)", async () => {
    const mine = await world.createTenant();
    const theirs = await world.createTenant();
    await expect(
      world.db.tx({ tenantId: mine.id }, (tx) =>
        audit().record(tx, {
          actor: 'SYSTEM',
          tenantId: theirs.id,
          action: 'sneaky',
          entityType: 'x',
          entityId: 'x',
        }),
      ),
    ).rejects.toThrow();
    expect(await world.auditRows(theirs)).toHaveLength(0);
  });

  it('is append-only for the application role: no UPDATE, no DELETE', async () => {
    const tenant = await world.createTenant();
    await world.db.tx({ tenantId: tenant.id }, (tx) =>
      audit().record(tx, {
        actor: 'SYSTEM',
        tenantId: tenant.id,
        action: 'keep',
        entityType: 'x',
        entityId: 'x',
      }),
    );
    await expect(
      world.db.tx({ tenantId: tenant.id }, (tx) =>
        tx.auditLog.updateMany({ data: { action: 'edited' } }),
      ),
    ).rejects.toThrow();
    await expect(
      world.db.tx({ tenantId: tenant.id }, (tx) => tx.auditLog.deleteMany({})),
    ).rejects.toThrow();
    expect(await world.auditRows(tenant, { action: 'keep' })).toHaveLength(1);
  });
});
