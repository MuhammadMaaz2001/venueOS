import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleListResponseSchema, RoleSchema } from '@venueos/shared';
import type { Permission } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';
import type { TestTenant } from '../../../__tests__/helpers/world';

// Module 2: retiring and restoring roles, and "manage needs view".

describe('roles: retire, restore and validation', () => {
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

  async function setup() {
    const tenant = await world.createTenant({ plan: 'growth' });
    const owner = await world.addMember(tenant, { role: 'owner' });
    const auth = t.as(authHeader(owner.userId, tenant.id));
    return { tenant, owner, auth };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;

  async function customRole(ctx: Ctx, name = 'Front desk') {
    const res = await t
      .http()
      .post('/v1/roles')
      .set(ctx.auth)
      .send({ name, copyFromRoleId: ctx.tenant.roles.sales_agent });
    expect(res.status).toBe(201);
    return RoleSchema.parse(res.body);
  }

  /** An active member holding `roleId` (the roles API does not assign; staff does, and the fixture is quicker). */
  async function giveRole(tenant: TestTenant, roleId: string, active = true) {
    const userId = await world.createUser('Holder');
    await world.db.tx({ tenantId: tenant.id, userId }, (tx) =>
      tx.membership.create({ data: { tenantId: tenant.id, userId, roleId, active, venueIds: [] } }),
    );
    return userId;
  }

  describe('PATCH /v1/roles/:id { active }', () => {
    it('200: retires a custom role without members, audits it, and the list hides it unless asked', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      expect(role).toMatchObject({ active: true, memberCount: 0 });

      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, active: false });
      expect(res.status).toBe(200);
      const retired = RoleSchema.parse(res.body);
      expect(retired.active).toBe(false);
      expect(retired.rev).toBe(role.rev + 1);

      const rows = await world.auditRows(ctx.tenant, { action: 'role.retire', entityId: role.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: ctx.owner.userId,
        before: { name: 'Front desk', active: true },
        after: { name: 'Front desk', active: false },
      });
      // No field changed: no `role.update` row.
      expect(await world.auditRows(ctx.tenant, { action: 'role.update' })).toHaveLength(0);

      const names = async (query: string) =>
        RoleListResponseSchema.parse(
          (await t.http().get(`/v1/roles${query}`).set(ctx.auth)).body,
        ).data.map((r) => r.name);
      expect(await names('')).not.toContain('Front desk');
      expect(await names('?status=active')).not.toContain('Front desk');
      expect(await names('?status=retired')).toEqual(['Front desk']);
      expect(await names('?status=all')).toContain('Front desk');
      expect(await names('?status=all')).toContain('Owner');
    });

    it('200: restores a retired role and audits it', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const retired = RoleSchema.parse(
        (
          await t
            .http()
            .patch(`/v1/roles/${role.id}`)
            .set(ctx.auth)
            .send({ rev: role.rev, active: false })
        ).body,
      );
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: retired.rev, active: true });
      expect(res.status).toBe(200);
      expect(RoleSchema.parse(res.body).active).toBe(true);
      const rows = await world.auditRows(ctx.tenant, { action: 'role.restore', entityId: role.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.after).toMatchObject({ active: true });
    });

    it('200: restore and edit in one request writes both audit rows', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const retired = RoleSchema.parse(
        (
          await t
            .http()
            .patch(`/v1/roles/${role.id}`)
            .set(ctx.auth)
            .send({ rev: role.rev, active: false })
        ).body,
      );
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: retired.rev, active: true, name: 'Front desk 2' });
      expect(res.status).toBe(200);
      expect(await world.auditRows(ctx.tenant, { action: 'role.restore' })).toHaveLength(1);
      expect(await world.auditRows(ctx.tenant, { action: 'role.update' })).toHaveLength(1);
    });

    it('422: a role with active members cannot be retired; inactive members do not count', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      await giveRole(ctx.tenant, role.id, false);
      const holder = await giveRole(ctx.tenant, role.id, true);

      const blocked = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, active: false });
      expect(blocked.status).toBe(422);
      expect(code(blocked)).toBe('INVALID_STATE_TRANSITION');
      expect(blocked.body.error.message).toContain('active members');
      expect(await world.auditRows(ctx.tenant, { action: 'role.retire' })).toHaveLength(0);

      const listed = RoleListResponseSchema.parse(
        (await t.http().get('/v1/roles').set(ctx.auth)).body,
      );
      expect(listed.data.find((r) => r.id === role.id)?.memberCount).toBe(1);

      // Once the last active member is gone, it can be retired.
      await world.db.tx({ tenantId: ctx.tenant.id }, (tx) =>
        tx.membership.updateMany({ where: { userId: holder }, data: { active: false } }),
      );
      const ok = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, active: false });
      expect(ok.status).toBe(200);
    });

    it('422: a system role cannot be retired', async () => {
      const ctx = await setup();
      const owner = RoleSchema.parse(
        (await t.http().get(`/v1/roles/${ctx.tenant.roles.operations}`).set(ctx.auth)).body,
      );
      const res = await t
        .http()
        .patch(`/v1/roles/${owner.id}`)
        .set(ctx.auth)
        .send({ rev: owner.rev, active: false });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('INVALID_STATE_TRANSITION');
    });

    it('422: a retired role is frozen and cannot be copied', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const retired = RoleSchema.parse(
        (
          await t
            .http()
            .patch(`/v1/roles/${role.id}`)
            .set(ctx.auth)
            .send({ rev: role.rev, active: false })
        ).body,
      );
      const edit = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: retired.rev, name: 'Renamed' });
      expect(edit.status).toBe(422);
      expect(code(edit)).toBe('INVALID_STATE_TRANSITION');

      const copy = await t
        .http()
        .post('/v1/roles')
        .set(ctx.auth)
        .send({ name: 'Copy of retired', copyFromRoleId: role.id });
      expect(copy.status).toBe(422);
      expect(code(copy)).toBe('INVALID_STATE_TRANSITION');
    });

    it('422: a retired role is not assignable (staff, invitations) and not offered by assignable-roles', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, active: false });

      const assignable = await t.http().get('/v1/staff/assignable-roles').set(ctx.auth);
      expect(assignable.status).toBe(200);
      expect(assignable.body.data.map((r: { id: string }) => r.id)).not.toContain(role.id);

      const other = await world.addMember(ctx.tenant, { role: 'operations' });
      const patch = await t
        .http()
        .patch(`/v1/staff/${other.membershipId}`)
        .set(ctx.auth)
        .send({ rev: 1, roleId: role.id });
      expect(patch.status).toBe(422);
      expect(code(patch)).toBe('INVALID_STATE_TRANSITION');

      const invite = await t
        .http()
        .post('/v1/staff/invitations')
        .set(ctx.auth)
        .send({ email: 'someone@example.test', roleId: role.id });
      expect(invite.status).toBe(422);
      expect(code(invite)).toBe('INVALID_STATE_TRANSITION');
    });

    it('400: active must be a boolean; an empty patch is still refused', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      for (const body of [{ rev: role.rev, active: 'no' }, { rev: role.rev }]) {
        const res = await t.http().patch(`/v1/roles/${role.id}`).set(ctx.auth).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
    });

    it('409: a stale rev', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev + 5, active: false });
      expect(res.status).toBe(409);
    });

    it('403: without role.manage; 401: without an identity', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const agent = await world.addMember(ctx.tenant, { role: 'sales_agent' });
      const forbidden = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(t.as(authHeader(agent.userId, ctx.tenant.id)))
        .send({ rev: role.rev, active: false });
      expect(forbidden.status).toBe(403);
      const anonymous = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(t.csrfHeaders)
        .send({ rev: role.rev, active: false });
      expect(anonymous.status).toBe(401);
    });

    it("404: another tenant's role", async () => {
      const a = await setup();
      const b = await setup();
      const role = await customRole(b);
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(a.auth)
        .send({ rev: role.rev, active: false });
      expect(res.status).toBe(404);
      const still = RoleSchema.parse((await t.http().get(`/v1/roles/${role.id}`).set(b.auth)).body);
      expect(still.active).toBe(true);
    });
  });

  describe('GET /v1/roles?status=', () => {
    it('400: an unknown status', async () => {
      const ctx = await setup();
      const res = await t.http().get('/v1/roles?status=everything').set(ctx.auth);
      expect(res.status).toBe(400);
      expect(code(res)).toBe('VALIDATION_ERROR');
    });

    it('counts active members per role', async () => {
      const ctx = await setup();
      const list = RoleListResponseSchema.parse(
        (await t.http().get('/v1/roles').set(ctx.auth)).body,
      );
      expect(list.data.find((r) => r.name === 'Owner')?.memberCount).toBe(1);
      expect(list.data.find((r) => r.name === 'Operations')?.memberCount).toBe(0);
      expect(list.data.every((r) => r.active)).toBe(true);
    });
  });

  describe('manage needs view', () => {
    it('400 VALIDATION_ERROR naming the missing permission', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const permissions: Permission[] = ['venue.manage', 'customer.manage', 'customer.view'];
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, permissions });
      expect(res.status).toBe(400);
      expect(code(res)).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).toContain('venue.view');
      expect(JSON.stringify(res.body)).not.toContain('"customer.view"');
    });

    it('200: manage together with view', async () => {
      const ctx = await setup();
      const role = await customRole(ctx);
      const res = await t
        .http()
        .patch(`/v1/roles/${role.id}`)
        .set(ctx.auth)
        .send({ rev: role.rev, permissions: ['venue.manage', 'venue.view', 'role.manage'] });
      expect(res.status).toBe(200);
    });
  });
});
