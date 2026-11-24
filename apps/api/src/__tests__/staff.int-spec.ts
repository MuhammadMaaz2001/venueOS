import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthHarness, TEST_ENV } from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { World } from './helpers/world';
import type { TestMember } from './helpers/world';

// GET /v1/staff and PATCH /v1/staff/:membershipId, including the last-owner rule.

describe('staff', () => {
  let t: TestApp;
  let h: AuthHarness;
  let world: World;

  beforeAll(async () => {
    t = await createTestApp({ env: TEST_ENV, realAuth: true });
    h = new AuthHarness();
    world = new World();
  });
  afterAll(async () => {
    await t.app.close();
    await h.close();
    await world.close();
  });

  type Member = TestMember & { email: string };
  const as = async (m: Member) => h.sessionHeaders(t, m.email);
  const patch = (
    headers: Record<string, string>,
    membershipId: string,
    body: Record<string, unknown>,
  ) => t.http().patch(`/v1/staff/${membershipId}`).set(headers).send(body);
  const rev = async (membershipId: string) =>
    Number(
      (await h.sql<{ rev: number }>(`SELECT rev FROM memberships WHERE id = $1`, [membershipId]))[0]
        ?.rev,
    );

  async function workspace(plan: 'starter' | 'growth' = 'growth') {
    const tenant = await world.createTenant({ plan });
    const owner = await h.member(world, tenant, { role: 'owner' });
    return { tenant, owner, ownerHeaders: await as(owner) };
  }

  describe('GET /v1/staff', () => {
    it('lists the members of this tenant with role, scope and rev, and nobody else', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      const agent = await h.member(world, tenant, { role: 'sales_agent' });
      const stranger = await workspace();

      const res = await t.http().get('/v1/staff').set(ownerHeaders);
      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.data.map((m: { userId: string }) => m.userId)).toEqual([
        owner.userId,
        agent.userId,
      ]);
      expect(res.body.data[1]).toMatchObject({
        membershipId: agent.membershipId,
        email: agent.email,
        roleName: 'Sales agent',
        venueIds: [],
        active: true,
        rev: 1,
      });
      expect(JSON.stringify(res.body)).not.toContain(stranger.owner.userId);
    });

    it('a caller limited to some venues sees the people whose scope touches theirs (or is all venues)', async () => {
      const { tenant } = await workspace();
      const v1 = await world.createVenue(tenant);
      const v2 = await world.createVenue(tenant);
      const caller = await h.member(world, tenant, {
        role: { permissions: ['staff.manage'] },
        venueIds: [v1],
      });
      const sameVenue = await h.member(world, tenant, { role: 'sales_agent', venueIds: [v1, v2] });
      const otherVenue = await h.member(world, tenant, { role: 'sales_agent', venueIds: [v2] });

      const res = await t
        .http()
        .get('/v1/staff')
        .set(await as(caller));
      const ids = res.body.data.map((m: { userId: string }) => m.userId);
      expect(ids).toContain(sameVenue.userId);
      expect(ids).not.toContain(otherVenue.userId);
    });

    it('needs staff.manage (403) and a login (401)', async () => {
      const { tenant } = await workspace();
      const viewer = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      expect(
        (
          await t
            .http()
            .get('/v1/staff')
            .set(await as(viewer))
        ).status,
      ).toBe(403);
      expect((await t.http().get('/v1/staff')).status).toBe(401);
    });
  });

  describe('GET /v1/staff/assignable-roles', () => {
    const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((r) => r.name);

    it('an owner may assign every role of the tenant; only id and name are returned', async () => {
      const { ownerHeaders } = await workspace();
      const res = await t.http().get('/v1/staff/assignable-roles').set(ownerHeaders);
      expect(res.status).toBe(200);
      expect(names(res)).toEqual(
        expect.arrayContaining(['Owner', 'Branch manager', 'Sales agent', 'Accountant']),
      );
      for (const role of res.body.data) expect(Object.keys(role).sort()).toEqual(['id', 'name']);
    });

    it('works with staff.manage alone (no role.manage) and hides roles above the caller (no escalation)', async () => {
      const { tenant } = await workspace();
      const manager = await h.member(world, tenant, {
        role: { permissions: ['staff.manage', 'customer.view'], limits: { maxDiscountPct: 0 } },
      });
      const headers = await as(manager);
      expect((await t.http().get('/v1/roles').set(headers)).status).toBe(403);

      const res = await t.http().get('/v1/staff/assignable-roles').set(headers);
      expect(res.status).toBe(200);
      // Owner, Branch manager, Sales agent, ... all hold permissions the caller lacks; only roles within
      // {staff.manage, customer.view} remain (none of the defaults, plus the caller's own custom role).
      expect(names(res)).not.toContain('Owner');
      expect(names(res)).not.toContain('Sales agent');
      expect(res.body.data.map((r: { id: string }) => r.id)).toContain(manager.roleId);
    });

    it("never lists another tenant's roles", async () => {
      const { ownerHeaders } = await workspace();
      const stranger = await workspace();
      const res = await t.http().get('/v1/staff/assignable-roles').set(ownerHeaders);
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(stranger.tenant.roles.owner);
    });

    it('needs staff.manage (403) and a login (401)', async () => {
      const { tenant } = await workspace();
      const viewer = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      expect(
        (
          await t
            .http()
            .get('/v1/staff/assignable-roles')
            .set(await as(viewer))
        ).status,
      ).toBe(403);
      expect((await t.http().get('/v1/staff/assignable-roles')).status).toBe(401);
    });
  });

  describe('PATCH /v1/staff/:membershipId', () => {
    it('changes role and venues, bumps rev, and audits before/after', async () => {
      const { tenant, ownerHeaders } = await workspace();
      const venue = await world.createVenue(tenant);
      const agent = await h.member(world, tenant, { role: 'sales_agent' });

      const res = await patch(ownerHeaders, agent.membershipId, {
        rev: 1,
        roleId: tenant.roles.accountant,
        venueIds: [venue],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        membershipId: agent.membershipId,
        roleName: 'Accountant',
        venueIds: [venue],
        active: true,
        rev: 2,
      });
      const audit = await world.auditRows(tenant, {
        action: 'staff.update',
        entityId: agent.membershipId,
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.before).toMatchObject({ roleName: 'Sales agent', venueIds: [] });
      expect(audit[0]?.after).toMatchObject({ roleName: 'Accountant', venueIds: [venue] });
    });

    it('takes effect on the very next request of that member (nothing is cached)', async () => {
      const { tenant, ownerHeaders } = await workspace();
      const agent = await h.member(world, tenant, { role: 'sales_agent' });
      const agentHeaders = await as(agent);
      expect((await t.http().get('/v1/me').set(agentHeaders)).body.access.roleName).toBe(
        'Sales agent',
      );

      await patch(ownerHeaders, agent.membershipId, { rev: 1, roleId: tenant.roles.operations });
      expect((await t.http().get('/v1/me').set(agentHeaders)).body.access.roleName).toBe(
        'Operations',
      );

      await patch(ownerHeaders, agent.membershipId, { rev: 2, active: false });
      expect((await t.http().get('/v1/roles').set(agentHeaders)).status).toBe(403);
      expect((await t.http().get('/v1/me').set(agentHeaders)).body.access).toBeNull();
    });

    it('validates the body (400), needs staff.manage (403), a login (401) and CSRF (403)', async () => {
      const { tenant, ownerHeaders } = await workspace();
      const agent = await h.member(world, tenant, { role: 'sales_agent' });
      expect((await patch(ownerHeaders, agent.membershipId, {})).status).toBe(400);
      expect((await patch(ownerHeaders, agent.membershipId, { rev: 1 })).status).toBe(400);
      expect(
        (await patch(ownerHeaders, agent.membershipId, { rev: 0, active: false })).status,
      ).toBe(400);
      expect((await patch(ownerHeaders, agent.membershipId, { rev: 1, active: 'no' })).status).toBe(
        400,
      );

      expect(
        (await patch(t.csrfHeaders, agent.membershipId, { rev: 1, active: false })).status,
      ).toBe(401);
      expect(
        (
          await patch({ Cookie: ownerHeaders.Cookie as string }, agent.membershipId, {
            rev: 1,
            active: false,
          })
        ).status,
      ).toBe(403);
      const other = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      expect(
        (await patch(await as(other), agent.membershipId, { rev: 1, active: false })).status,
      ).toBe(403);
    });

    it("another tenant's membership, role or venue, or an unknown id: 404", async () => {
      const a = await workspace();
      const b = await workspace();
      const theirs = await h.member(world, b.tenant, { role: 'sales_agent' });
      const mine = await h.member(world, a.tenant, { role: 'sales_agent' });
      const theirVenue = await world.createVenue(b.tenant);

      expect(
        (await patch(a.ownerHeaders, theirs.membershipId, { rev: 1, active: false })).status,
      ).toBe(404);
      expect(
        (await patch(a.ownerHeaders, 'no-such-membership', { rev: 1, active: false })).status,
      ).toBe(404);
      expect(
        (await patch(a.ownerHeaders, mine.membershipId, { rev: 1, roleId: b.tenant.roles.owner }))
          .status,
      ).toBe(404);
      expect(
        (await patch(a.ownerHeaders, mine.membershipId, { rev: 1, venueIds: [theirVenue] })).status,
      ).toBe(404);
      expect(await rev(theirs.membershipId)).toBe(1);
      expect(await rev(mine.membershipId)).toBe(1);
    });

    it('answers 409 VERSION_CONFLICT for a stale rev', async () => {
      const { tenant, ownerHeaders } = await workspace();
      const agent = await h.member(world, tenant, { role: 'sales_agent' });
      expect(
        (await patch(ownerHeaders, agent.membershipId, { rev: 1, active: false })).status,
      ).toBe(200);
      const stale = await patch(ownerHeaders, agent.membershipId, { rev: 1, active: true });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('cannot assign a role with permissions the caller lacks (403), nor manage someone with more access', async () => {
      const { tenant, ownerHeaders } = await workspace();
      const manager = await h.member(world, tenant, {
        role: { permissions: ['staff.manage', 'customer.view'] },
      });
      const managerHeaders = await as(manager);
      const agent = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      const powerful = await h.member(world, tenant, { role: 'accountant' });

      const up = await patch(managerHeaders, agent.membershipId, {
        rev: 1,
        roleId: tenant.roles.owner,
      });
      expect(up.status).toBe(403);
      expect(up.body.error.code).toBe('FORBIDDEN');
      const above = await patch(managerHeaders, powerful.membershipId, { rev: 1, active: false });
      expect(above.status).toBe(403);
      const owner = await t.http().get('/v1/staff').set(ownerHeaders);
      const ownerRow = owner.body.data[0];
      expect(
        (await patch(managerHeaders, ownerRow.membershipId, { rev: ownerRow.rev, active: false }))
          .status,
      ).toBe(403);
      // Within their own reach it works.
      expect(
        (await patch(managerHeaders, agent.membershipId, { rev: 1, active: false })).status,
      ).toBe(200);
    });

    it('a caller limited to some venues cannot hand out other venues, "all venues", or touch broader members', async () => {
      const { tenant } = await workspace();
      const v1 = await world.createVenue(tenant);
      const v2 = await world.createVenue(tenant);
      const caller = await h.member(world, tenant, {
        role: { permissions: ['staff.manage'] },
        venueIds: [v1],
      });
      const callerHeaders = await as(caller);
      const inside = await h.member(world, tenant, {
        role: { permissions: ['staff.manage'] },
        venueIds: [v1],
      });
      const broad = await h.member(world, tenant, {
        role: { permissions: ['staff.manage'] },
        venueIds: [],
      });

      expect(
        (await patch(callerHeaders, inside.membershipId, { rev: 1, venueIds: [v2] })).status,
      ).toBe(403);
      expect(
        (await patch(callerHeaders, inside.membershipId, { rev: 1, venueIds: [] })).status,
      ).toBe(403);
      expect(
        (await patch(callerHeaders, broad.membershipId, { rev: 1, active: false })).status,
      ).toBe(403);
      expect(
        (await patch(callerHeaders, inside.membershipId, { rev: 1, venueIds: [v1] })).status,
      ).toBe(200);
    });

    it('re-activating a member uses a seat of the plan (402 when the plan is full)', async () => {
      const { tenant, ownerHeaders } = await workspace('starter');
      const members = [];
      for (let i = 0; i < 4; i++)
        members.push(await h.member(world, tenant, { role: 'sales_agent' })); // 5 of 5
      await patch(ownerHeaders, members[0]!.membershipId, { rev: 1, active: false });
      const extra = await h.member(world, tenant, { role: 'sales_agent' }); // the seat is taken again
      expect(extra.userId).toBeDefined();
      const res = await patch(ownerHeaders, members[0]!.membershipId, { rev: 2, active: true });
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });
  });

  describe('a workspace always keeps one active Owner (422 INVALID_STATE_TRANSITION)', () => {
    const expectLastOwner = (res: { status: number; body: { error: { code: string } } }) => {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    };

    it('the only owner cannot be deactivated, not even by themself', async () => {
      const { owner, ownerHeaders } = await workspace();
      expectLastOwner(await patch(ownerHeaders, owner.membershipId, { rev: 1, active: false }));
      expect(await h.count('memberships', 'id = $1 AND active', [owner.membershipId])).toBe(1);
    });

    it('the only owner cannot be moved to another role', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      expectLastOwner(
        await patch(ownerHeaders, owner.membershipId, {
          rev: 1,
          roleId: tenant.roles.branch_manager,
        }),
      );
      expect(
        await h.count('memberships', 'id = $1 AND role_id = $2', [
          owner.membershipId,
          tenant.roles.owner,
        ]),
      ).toBe(1);
    });

    it('with a second owner, one of them can step down; the remaining one is then the last', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      const second = await h.member(world, tenant, { role: 'owner' });
      const secondHeaders = await as(second);

      expect(
        (await patch(ownerHeaders, second.membershipId, { rev: 1, active: false })).status,
      ).toBe(200);
      expectLastOwner(await patch(ownerHeaders, owner.membershipId, { rev: 1, active: false }));
      // Put the second owner back, demote the first: the rule holds at every step.
      expect(
        (await patch(ownerHeaders, second.membershipId, { rev: 2, active: true })).status,
      ).toBe(200);
      expect(
        (await patch(ownerHeaders, owner.membershipId, { rev: 1, roleId: tenant.roles.operations }))
          .status,
      ).toBe(200);
      expectLastOwner(
        await patch(secondHeaders, second.membershipId, {
          rev: 3,
          roleId: tenant.roles.operations,
        }),
      );
    });

    it('an inactive owner does not count: with the other owner deactivated, the active one is the last', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      const second = await h.member(world, tenant, { role: 'owner' });
      await h.sql(`UPDATE memberships SET active = false WHERE id = $1`, [second.membershipId]);
      expectLastOwner(await patch(ownerHeaders, owner.membershipId, { rev: 1, active: false }));
    });

    it('two owners removing each other at the same moment: exactly one succeeds', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      const second = await h.member(world, tenant, { role: 'owner' });
      const secondHeaders = await as(second);
      for (let round = 0; round < 3; round++) {
        const a = await rev(owner.membershipId);
        const b = await rev(second.membershipId);
        const results = await Promise.all([
          patch(secondHeaders, owner.membershipId, { rev: a, active: false }),
          patch(ownerHeaders, second.membershipId, { rev: b, active: false }),
        ]);
        // The loser is refused either by the owner rule (422: it got past the guards before the winner
        // committed) or because its own membership was already deactivated (403): never both succeed.
        const [winner, loser] = results.map((r) => r.status).sort((x, y) => x - y);
        expect(winner).toBe(200);
        expect([403, 422]).toContain(loser);
        expect(
          await h.count('memberships', `tenant_id = $1 AND active AND role_id = $2`, [
            tenant.id,
            tenant.roles.owner,
          ]),
        ).toBe(1);
        // Put the removed owner back for the next round.
        await h.sql(`UPDATE memberships SET active = true WHERE tenant_id = $1 AND role_id = $2`, [
          tenant.id,
          tenant.roles.owner,
        ]);
      }
    });

    it('a custom role named like the Owner role does not count as an owner', async () => {
      const { tenant, owner, ownerHeaders } = await workspace();
      await h.member(world, tenant, {
        role: { name: 'Owner (custom)', permissions: ['staff.manage'] },
      });
      expectLastOwner(await patch(ownerHeaders, owner.membershipId, { rev: 1, active: false }));
    });
  });
});
