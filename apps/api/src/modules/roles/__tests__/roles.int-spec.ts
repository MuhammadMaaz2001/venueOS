import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, RoleListResponseSchema, RoleSchema } from '@venueos/shared';
import type { Permission } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';
import type { TestTenant } from '../../../__tests__/helpers/world';

describe('roles endpoints', () => {
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

  /**
   * A fresh tenant with an Owner (`ownerAuth`) and a caller (`auth`, the Owner unless `role` says
   * otherwise). Tests that need a role to edit create it as the Owner.
   */
  async function setup(
    role: Parameters<World['addMember']>[1] = { role: 'owner' },
    tenantOptions: Parameters<World['createTenant']>[0] = {},
  ) {
    const tenant = await world.createTenant(tenantOptions);
    const ownerMember = await world.addMember(tenant, { role: 'owner' });
    const ownerAuth = t.as(authHeader(ownerMember.userId, tenant.id));
    const isOwner = role.role === 'owner';
    const member = isOwner ? ownerMember : await world.addMember(tenant, role);
    const auth = isOwner ? ownerAuth : t.as(authHeader(member.userId, tenant.id));
    return { tenant, member, auth, ownerAuth };
  }

  const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
  const roleId = (tenant: TestTenant, key: keyof TestTenant['roles']) => tenant.roles[key];

  /** A role that can manage roles but holds only the listed permissions (and discount limit). */
  const manager = (extra: Permission[] = [], maxDiscountPct = 0) => ({
    role: { permissions: ['role.manage', ...extra] as Permission[], limits: { maxDiscountPct } },
  });

  describe('GET /v1/roles', () => {
    it('200: lists the five default roles of the tenant, system roles first', async () => {
      const { auth } = await setup();
      const res = await t.http().get('/v1/roles').set(auth);
      expect(res.status).toBe(200);
      const parsed = RoleListResponseSchema.parse(res.body);
      expect(parsed.nextCursor).toBeNull();
      expect(parsed.data.map((r) => r.name)).toEqual([
        'Accountant',
        'Branch manager',
        'Operations',
        'Owner',
        'Sales agent',
      ]);
      const owner = parsed.data.find((r) => r.name === 'Owner');
      expect(owner?.permissions).toHaveLength(PERMISSIONS.length);
      expect(owner?.isSystem).toBe(true);
    });

    it("only lists the caller's tenant roles", async () => {
      const a = await setup();
      const b = await setup();
      const copy = await t
        .http()
        .post('/v1/roles')
        .set(b.auth)
        .send({ name: 'Only in B', copyFromRoleId: roleId(b.tenant, 'operations') });
      expect(copy.status).toBe(201);
      const list = await t.http().get('/v1/roles').set(a.auth);
      expect(list.body.data.map((r: { name: string }) => r.name)).not.toContain('Only in B');
      expect(list.body.data).toHaveLength(5);
    });

    it('403: without role.manage', async () => {
      const { auth } = await setup({ role: 'sales_agent' });
      const res = await t.http().get('/v1/roles').set(auth);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('401: without an identity', async () => {
      expect((await t.http().get('/v1/roles')).status).toBe(401);
    });

    it('still works on a suspended tenant (read-only)', async () => {
      const { auth } = await setup({ role: 'owner' }, { status: 'SUSPENDED' });
      expect((await t.http().get('/v1/roles').set(auth)).status).toBe(200);
    });
  });

  describe('GET /v1/roles/:id', () => {
    it('200: returns the role', async () => {
      const { tenant, auth } = await setup();
      const res = await t
        .http()
        .get(`/v1/roles/${roleId(tenant, 'accountant')}`)
        .set(auth);
      expect(res.status).toBe(200);
      const role = RoleSchema.parse(res.body);
      expect(role).toMatchObject({
        name: 'Accountant',
        isSystem: true,
        limits: { maxDiscountPct: 0 },
      });
      expect(role.rev).toBeGreaterThanOrEqual(1);
    });

    it('400: malformed id', async () => {
      const { auth } = await setup();
      const res = await t.http().get('/v1/roles/bad%20id').set(auth);
      expect(res.status).toBe(400);
      expect(code(res)).toBe('VALIDATION_ERROR');
    });

    it('403: without role.manage', async () => {
      const { tenant, auth } = await setup({ role: 'accountant' });
      const res = await t
        .http()
        .get(`/v1/roles/${roleId(tenant, 'owner')}`)
        .set(auth);
      expect(res.status).toBe(403);
    });

    it("404: another tenant's role looks the same as a missing one", async () => {
      const a = await setup();
      const b = await setup();
      const other = await t
        .http()
        .get(`/v1/roles/${roleId(b.tenant, 'owner')}`)
        .set(a.auth);
      const missing = await t.http().get('/v1/roles/rol_nope').set(a.auth);
      expect(other.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(code(other)).toBe('NOT_FOUND');
      expect(other.body.error.message).toBe(missing.body.error.message);
    });
  });

  describe('POST /v1/roles (create by copying)', () => {
    it('201: a custom role copies permissions and limits and is not a system role', async () => {
      const { tenant, auth, member } = await setup();
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Front desk', copyFromRoleId: roleId(tenant, 'sales_agent') });
      expect(res.status).toBe(201);
      const role = RoleSchema.parse(res.body);
      expect(role).toMatchObject({
        name: 'Front desk',
        isSystem: false,
        limits: { maxDiscountPct: 5 },
        rev: 1,
      });
      const source = (
        await t
          .http()
          .get(`/v1/roles/${roleId(tenant, 'sales_agent')}`)
          .set(auth)
      ).body;
      expect(role.permissions).toEqual(source.permissions);

      const rows = await world.auditRows(tenant, { action: 'role.create' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'USER',
        actorUserId: member.userId,
        entityType: 'role',
        entityId: role.id,
      });
      expect(rows[0]?.after).toMatchObject({
        name: 'Front desk',
        copiedFromRoleId: roleId(tenant, 'sales_agent'),
      });
    });

    it('400: missing, empty or oversized fields; unknown keys are ignored', async () => {
      const { tenant, auth } = await setup();
      const source = roleId(tenant, 'operations');
      for (const payload of [
        {},
        { name: 'x' },
        { copyFromRoleId: source },
        { name: '   ', copyFromRoleId: source },
        { name: 'n'.repeat(61), copyFromRoleId: source },
        { name: 'ok', copyFromRoleId: 'bad id!' },
        { name: 123, copyFromRoleId: source },
      ]) {
        const res = await t.http().post('/v1/roles').set(auth).send(payload);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
      const extra = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({
          name: 'Extras ignored',
          copyFromRoleId: source,
          isSystem: true,
          permissions: ['billing.manage'],
        });
      expect(extra.status).toBe(201);
      expect(extra.body.isSystem).toBe(false);
      expect(extra.body.permissions).not.toContain('billing.manage');
    });

    it('403: without role.manage', async () => {
      const { tenant, auth } = await setup({ role: 'branch_manager' });
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Nope', copyFromRoleId: roleId(tenant, 'operations') });
      expect(res.status).toBe(403);
    });

    it('403 CSRF_REJECTED: without the CSRF headers', async () => {
      const { tenant, member } = await setup();
      const res = await t
        .http()
        .post('/v1/roles')
        .set(authHeader(member.userId, tenant.id))
        .send({ name: 'Nope', copyFromRoleId: roleId(tenant, 'operations') });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('CSRF_REJECTED');
    });

    it("404: copying another tenant's role, or a missing one", async () => {
      const a = await setup();
      const b = await setup();
      for (const copyFromRoleId of [roleId(b.tenant, 'owner'), 'rol_nope']) {
        const res = await t
          .http()
          .post('/v1/roles')
          .set(a.auth)
          .send({ name: 'Stolen', copyFromRoleId });
        expect(res.status).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
      }
      const list = await t.http().get('/v1/roles').set(a.auth);
      expect(list.body.data.map((r: { name: string }) => r.name)).not.toContain('Stolen');
    });

    it('409 DUPLICATE: the name is taken in this tenant (but free in another)', async () => {
      const a = await setup();
      const b = await setup();
      const body = (tenant: TestTenant) => ({
        name: 'Cashier',
        copyFromRoleId: roleId(tenant, 'accountant'),
      });
      expect((await t.http().post('/v1/roles').set(a.auth).send(body(a.tenant))).status).toBe(201);
      const again = await t.http().post('/v1/roles').set(a.auth).send(body(a.tenant));
      expect(again.status).toBe(409);
      expect(code(again)).toBe('DUPLICATE');
      const system = await t
        .http()
        .post('/v1/roles')
        .set(a.auth)
        .send({ name: 'Owner', copyFromRoleId: roleId(a.tenant, 'operations') });
      expect(system.status).toBe(409);
      expect((await t.http().post('/v1/roles').set(b.auth).send(body(b.tenant))).status).toBe(201);
    });

    it('403: cannot copy a role that holds permissions the caller lacks', async () => {
      const { tenant, auth } = await setup(manager(['customer.view']));
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Boss clone', copyFromRoleId: roleId(tenant, 'owner') });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('201: copying a role within the caller own permissions is fine', async () => {
      const { tenant, auth } = await setup(
        manager([
          'eventsheet.view',
          'booking.view',
          'vendor.view',
          'inventory.view',
          'inventory.record',
        ]),
      );
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Ops copy', copyFromRoleId: roleId(tenant, 'operations') });
      expect(res.status).toBe(201);
    });

    it('403: cannot copy a role with a higher discount limit than the caller has', async () => {
      const { tenant, auth } = await setup({
        role: {
          permissions: [...PERMISSIONS].filter((p) => p !== 'billing.manage') as Permission[],
          limits: { maxDiscountPct: 5 },
        },
      });
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Generous', copyFromRoleId: roleId(tenant, 'branch_manager') }); // 15%
      expect(res.status).toBe(403);
    });

    it('403 TENANT_SUSPENDED: a suspended tenant cannot create roles', async () => {
      const { tenant, auth } = await setup({ role: 'owner' }, { status: 'SUSPENDED' });
      const res = await t
        .http()
        .post('/v1/roles')
        .set(auth)
        .send({ name: 'Nope', copyFromRoleId: roleId(tenant, 'operations') });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('TENANT_SUSPENDED');
    });
  });

  describe('PATCH /v1/roles/:id', () => {
    async function customRole(
      ctx: Awaited<ReturnType<typeof setup>>,
      name = 'Custom',
      from = 'sales_agent',
    ) {
      const res = await t
        .http()
        .post('/v1/roles')
        .set(ctx.ownerAuth)
        .send({ name, copyFromRoleId: roleId(ctx.tenant, from as keyof TestTenant['roles']) });
      expect(res.status).toBe(201);
      return res.body as { id: string; rev: number; permissions: Permission[]; name: string };
    }

    it('200: edits permissions and limits, bumps rev and writes an audit row with before and after', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({
          rev: role.rev,
          permissions: ['customer.view', 'booking.view'],
          limits: { maxDiscountPct: 7.5 },
        });
      expect(res.status).toBe(200);
      const updated = RoleSchema.parse(res.body);
      expect(updated.permissions).toEqual(['customer.view', 'booking.view']);
      expect(updated.limits).toEqual({ maxDiscountPct: 7.5 });
      expect(updated.rev).toBe(role.rev + 1);

      const rows = await world.auditRows(ctx.tenant, { action: 'role.update', entityId: role.id });
      expect(rows).toHaveLength(1);
      expect((rows[0]?.before as { permissions: string[] }).permissions).toEqual(role.permissions);
      expect((rows[0]?.after as { permissions: string[] }).permissions).toEqual([
        'customer.view',
        'booking.view',
      ]);
      expect(rows[0]?.actorUserId).toBe(ctx.member.userId);
    });

    it('200: renames a custom role; permissions are de-duplicated and put in documented order', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({
          rev: role.rev,
          name: 'Renamed',
          permissions: ['booking.view', 'customer.view', 'booking.view'],
        });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        permissions: ['customer.view', 'booking.view'],
      });
    });

    it('200: a system role keeps its name but its permissions and limits are editable', async () => {
      const ctx = await setup();
      const id = roleId(ctx.tenant, 'accountant');
      const current = (await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body;
      const same = await t
        .http()
        .patch(`/v1/roles/${id}`)
        .set(ctx.auth)
        .send({ rev: current.rev, name: 'Accountant', permissions: ['payment.view'] });
      expect(same.status).toBe(200);
      expect(same.body).toMatchObject({
        name: 'Accountant',
        isSystem: true,
        permissions: ['payment.view'],
      });
    });

    it('400: bad payloads', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      for (const payload of [
        {},
        { rev: role.rev },
        { name: 'x' },
        { rev: 0, name: 'x' },
        { rev: 'one', name: 'x' },
        { rev: role.rev, permissions: ['booking.explode'] },
        { rev: role.rev, permissions: 'booking.view' },
        { rev: role.rev, limits: { maxDiscountPct: 150 } },
        { rev: role.rev, limits: { maxDiscountPct: -1 } },
        { rev: role.rev, limits: {} },
        { rev: role.rev, name: '' },
      ]) {
        const res = await t.http().patch(`/v1/roles/${role.id}`).set(ctx.auth).send(payload);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
    });

    it('403: without role.manage', async () => {
      const ctx = await setup({ role: 'branch_manager' });
      const res = await t
        .http()
        .patch(`/v1/roles/${roleId(ctx.tenant, 'operations')}`)
        .set(ctx.auth)
        .send({ rev: 1, permissions: ['eventsheet.view'] });
      expect(res.status).toBe(403);
    });

    it("404: another tenant's role (and nothing changes there)", async () => {
      const a = await setup();
      const b = await setup();
      const target = roleId(b.tenant, 'operations');
      const before = (await t.http().get(`/v1/roles/${target}`).set(b.auth)).body;
      const res = await t
        .http()
        .patch(`/v1/roles/${target}`)
        .set(a.auth)
        .send({ rev: before.rev, permissions: ['eventsheet.view'] });
      expect(res.status).toBe(404);
      expect(code(res)).toBe('NOT_FOUND');
      const after = (await t.http().get(`/v1/roles/${target}`).set(b.auth)).body;
      expect(after).toEqual(before);
      expect(await world.auditRows(b.tenant, { action: 'role.update' })).toHaveLength(0);
    });

    it('404: unknown role id', async () => {
      const ctx = await setup();
      const res = await t
        .http()
        .patch('/v1/roles/rol_nope')
        .set(ctx.auth)
        .send({ rev: 1, name: 'x' });
      expect(res.status).toBe(404);
    });

    it('409 VERSION_CONFLICT: a stale rev changes nothing', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const first = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, name: 'First edit' });
      expect(first.status).toBe(200);
      const stale = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, name: 'Second edit' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect((await t.http().get(`/v1/roles/${role.id}`).set(ctx.auth)).body.name).toBe(
        'First edit',
      );
    });

    it('409 DUPLICATE: renaming onto an existing name', async () => {
      const ctx = await setup();
      const role = await customRole(ctx, 'One');
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, name: 'Accountant' });
      expect(res.status).toBe(409);
      expect(code(res)).toBe('DUPLICATE');
    });

    it('422 INVALID_STATE_TRANSITION: the name of a system role is locked', async () => {
      const ctx = await setup();
      const id = roleId(ctx.tenant, 'branch_manager');
      const current = (await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body;
      const res = await t
        .http()
        .patch(`/v1/roles/${id}`)
        .set(ctx.auth)
        .send({ rev: current.rev, name: 'Manager' });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('INVALID_STATE_TRANSITION');
      expect((await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body.name).toBe(
        'Branch manager',
      );
    });

    describe('Owner lock-out guard', () => {
      it('422: the Owner role cannot lose role.manage or staff.manage', async () => {
        const ctx = await setup();
        const id = roleId(ctx.tenant, 'owner');
        const current = (await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body;
        for (const drop of ['role.manage', 'staff.manage']) {
          const permissions = current.permissions.filter((p: string) => p !== drop);
          const res = await t
            .http()
            .patch(`/v1/roles/${id}`)
            .set(ctx.auth)
            .send({ rev: current.rev, permissions });
          expect(res.status, drop).toBe(422);
          expect(code(res)).toBe('INVALID_STATE_TRANSITION');
        }
        const after = (await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body;
        expect(after.permissions).toEqual(current.permissions);
      });

      it('200: the Owner role may lose other permissions', async () => {
        const ctx = await setup();
        const id = roleId(ctx.tenant, 'owner');
        const current = (await t.http().get(`/v1/roles/${id}`).set(ctx.auth)).body;
        const permissions = current.permissions.filter((p: string) => p !== 'template.manage');
        const res = await t
          .http()
          .patch(`/v1/roles/${id}`)
          .set(ctx.auth)
          .send({ rev: current.rev, permissions });
        expect(res.status).toBe(200);
      });
    });

    describe('privilege-escalation guard', () => {
      it('403: cannot add a permission the caller does not hold', async () => {
        const ctx = await setup(manager(['customer.view', 'booking.view']));
        const target = await customRole(ctx, 'Low', 'operations');
        const res = await t
          .http()
          .patch(`/v1/roles/${target.id}`)
          .set(ctx.auth)
          .send({ rev: target.rev, permissions: ['booking.view', 'billing.manage'] });
        expect(res.status).toBe(403);
        expect(code(res)).toBe('FORBIDDEN');
        const unchanged = (await t.http().get(`/v1/roles/${target.id}`).set(ctx.ownerAuth)).body;
        expect(unchanged.permissions).not.toContain('billing.manage');
        expect(unchanged.rev).toBe(target.rev);
      });

      it('403: cannot escalate by editing the role they hold themselves', async () => {
        const ctx = await setup(manager());
        const own = (await t.http().get(`/v1/roles/${ctx.member.roleId}`).set(ctx.auth)).body;
        const res = await t
          .http()
          .patch(`/v1/roles/${ctx.member.roleId}`)
          .set(ctx.auth)
          .send({ rev: own.rev, permissions: ['role.manage', 'billing.manage'] });
        expect(res.status).toBe(403);
      });

      it('200: can add permissions the caller holds, and remove or keep ones they do not', async () => {
        const ctx = await setup(manager(['customer.view']));
        const accountant = (
          await t
            .http()
            .get(`/v1/roles/${roleId(ctx.tenant, 'accountant')}`)
            .set(ctx.auth)
        ).body;
        // Removing permissions the caller lacks (payment.*) is allowed; adding customer.view (held) too.
        const res = await t
          .http()
          .patch(`/v1/roles/${roleId(ctx.tenant, 'accountant')}`)
          .set(ctx.auth)
          .send({ rev: accountant.rev, permissions: ['customer.view', 'payment.view'] });
        expect(res.status).toBe(200);
      });

      it('200: renaming a role that holds permissions the caller lacks is fine', async () => {
        const ctx = await setup(manager());
        const high = await customRole(ctx, 'High', 'owner');
        // The caller holds role.manage only; the role they rename holds everything.
        const res = await t
          .http()
          .patch(`/v1/roles/${high.id}`)
          .set(ctx.auth)
          .send({ rev: high.rev, name: 'High renamed' });
        expect(res.status).toBe(200);
      });

      it('403: cannot raise the discount limit above their own; 200 when at or below it', async () => {
        const ctx = await setup(manager([], 10));
        const role = await customRole(ctx, 'Disc', 'operations');
        const tooHigh = await t
          .http()
          .patch(`/v1/roles/${role.id}`)
          .set(ctx.auth)
          .send({ rev: role.rev, limits: { maxDiscountPct: 11 } });
        expect(tooHigh.status).toBe(403);
        const fine = await t
          .http()
          .patch(`/v1/roles/${role.id}`)
          .set(ctx.auth)
          .send({ rev: role.rev, limits: { maxDiscountPct: 10 } });
        expect(fine.status).toBe(200);
        const lower = await t
          .http()
          .patch(`/v1/roles/${role.id}`)
          .set(ctx.auth)
          .send({ rev: fine.body.rev, limits: { maxDiscountPct: 2 } });
        expect(lower.status).toBe(200);
      });
    });

    it('403 TENANT_SUSPENDED: a suspended tenant cannot edit roles', async () => {
      const ctx = await setup({ role: 'owner' }, { status: 'SUSPENDED' });
      const res = await t
        .http()
        .patch(`/v1/roles/${roleId(ctx.tenant, 'operations')}`)
        .set(ctx.auth)
        .send({ rev: 1, permissions: ['eventsheet.view'] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('TENANT_SUSPENDED');
    });

    it('changes the effect on members at once: the next request of an affected user is re-checked', async () => {
      const ctx = await setup();
      const staff = await world.addMember(ctx.tenant, { role: 'operations' });
      const staffAuth = t.as(authHeader(staff.userId, ctx.tenant.id));
      expect((await t.http().get('/v1/roles').set(staffAuth)).status).toBe(403);

      const ops = (await t.http().get(`/v1/roles/${staff.roleId}`).set(ctx.auth)).body;
      const res = await t
        .http()
        .patch(`/v1/roles/${staff.roleId}`)
        .set(ctx.auth)
        .send({ rev: ops.rev, permissions: [...ops.permissions, 'role.manage'] });
      expect(res.status).toBe(200);
      expect((await t.http().get('/v1/roles').set(staffAuth)).status).toBe(200);
    });
  });
});
