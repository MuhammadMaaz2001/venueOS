import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { authHeader } from './helpers/test-auth';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// Guard chain (docs/02 request lifecycle): AuthGuard -> TenantGuard -> PermissionGuard -> EntitlementGuard.

describe('access guards', () => {
  let t: TestApp;
  let world: World;
  let tenant: TestTenant;

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
    tenant = await world.createTenant();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const body = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;

  describe('AuthGuard', () => {
    it('answers 401 UNAUTHENTICATED when nobody is identified', async () => {
      const res = await t.http().get('/v1/_access/read');
      expect(res.status).toBe(401);
      expect(body(res)).toBe('UNAUTHENTICATED');
    });

    it('answers 401 for an unparsable identity', async () => {
      const res = await t.http().get('/v1/_access/read').set('x-test-auth', '{not json');
      expect(res.status).toBe(401);
    });

    it('lets @Public() routes through without an identity', async () => {
      expect((await t.http().get('/health')).status).toBe(200);
    });

    it('answers 403 when the session has no active tenant yet', async () => {
      const user = await world.createUser();
      const res = await t.http().get('/v1/_access/read').set(authHeader(user, null));
      expect(res.status).toBe(403);
      expect(body(res)).toBe('FORBIDDEN');
    });
  });

  describe('TenantGuard', () => {
    it('answers 403 when the user has no membership in the active tenant', async () => {
      const stranger = await world.createUser();
      const res = await t.http().get('/v1/_access/read').set(authHeader(stranger, tenant.id));
      expect(res.status).toBe(403);
      expect(body(res)).toBe('FORBIDDEN');
    });

    it('answers 403 when the membership is inactive', async () => {
      const m = await world.addMember(tenant, { role: 'owner', active: false });
      const res = await t.http().get('/v1/_access/read').set(authHeader(m.userId, tenant.id));
      expect(res.status).toBe(403);
    });

    it('answers 403 when a member of tenant A names tenant B as active tenant', async () => {
      const other = await world.createTenant();
      const m = await world.addMember(tenant, { role: 'owner' });
      const res = await t.http().get('/v1/_access/read').set(authHeader(m.userId, other.id));
      expect(res.status).toBe(403);
      expect(body(res)).toBe('FORBIDDEN');
    });

    it('answers 403 for an unknown tenant id', async () => {
      const user = await world.createUser();
      const res = await t
        .http()
        .get('/v1/_access/read')
        .set(authHeader(user, 'tnt_does_not_exist'));
      expect(res.status).toBe(403);
    });

    it('fills the context from membership, role and tenant', async () => {
      const venue = await world.createVenue(tenant);
      const m = await world.addMember(tenant, { role: 'sales_agent', venueIds: [venue] });
      const res = await t.http().get('/v1/_access/read').set(authHeader(m.userId, tenant.id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        tenantId: tenant.id,
        userId: m.userId,
        access: {
          tenantId: tenant.id,
          membershipId: m.membershipId,
          roleName: 'Sales agent',
          venueIds: [venue],
          limits: { maxDiscountPct: 5 },
        },
      });
      expect(res.body.access.permissions).toContain('booking.confirm');
    });

    it('ignores a tenant id sent in the query or body (the session decides)', async () => {
      const other = await world.createTenant();
      const m = await world.addMember(tenant, { role: 'owner' });
      const res = await t
        .http()
        .get(`/v1/_access/read?tenantId=${other.id}`)
        .set(authHeader(m.userId, tenant.id));
      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe(tenant.id);
    });

    it("sets the ambient TenantDb context (RLS shows only the caller's tenant)", async () => {
      const mine = await world.createTenant();
      const theirs = await world.createTenant();
      const a = await world.addMember(mine, { role: 'owner' });
      await world.addMember(mine, { role: 'operations' });
      await world.addMember(theirs, { role: 'owner' });
      const res = await t.http().get('/v1/_access/members').set(authHeader(a.userId, mine.id));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 2 });
    });

    describe('tenant status', () => {
      it('SUSPENDED: reads pass, writes answer 403 TENANT_SUSPENDED', async () => {
        const suspended = await world.createTenant({ status: 'SUSPENDED' });
        const m = await world.addMember(suspended, { role: 'owner' });
        const auth = authHeader(m.userId, suspended.id);

        const read = await t.http().get('/v1/_access/read').set(auth);
        expect(read.status).toBe(200);

        for (const method of ['post', 'patch', 'put', 'delete'] as const) {
          const res = await t.http()[method]('/v1/_access/write').set(t.as(auth));
          expect(res.status, method).toBe(403);
          expect(body(res), method).toBe('TENANT_SUSPENDED');
        }
      });

      it('SUSPENDED: a non-member still gets plain FORBIDDEN (status is not revealed)', async () => {
        const suspended = await world.createTenant({ status: 'SUSPENDED' });
        const stranger = await world.createUser();
        const res = await t
          .http()
          .post('/v1/_access/write')
          .set(t.as(authHeader(stranger, suspended.id)));
        expect(res.status).toBe(403);
        expect(body(res)).toBe('FORBIDDEN');
      });

      it('CANCELLED: every request answers 403, reads included', async () => {
        const cancelled = await world.createTenant({ status: 'CANCELLED' });
        const m = await world.addMember(cancelled, { role: 'owner' });
        const auth = authHeader(m.userId, cancelled.id);
        expect((await t.http().get('/v1/_access/read').set(auth)).status).toBe(403);
        expect((await t.http().post('/v1/_access/write').set(t.as(auth))).status).toBe(403);
      });

      it.each(['TRIAL', 'ACTIVE', 'PAST_DUE'] as const)(
        '%s: reads and writes pass',
        async (status) => {
          const open = await world.createTenant({ status });
          const m = await world.addMember(open, { role: 'owner' });
          const auth = authHeader(m.userId, open.id);
          expect((await t.http().get('/v1/_access/read').set(auth)).status).toBe(200);
          expect((await t.http().post('/v1/_access/write').set(t.as(auth))).status).toBe(201);
        },
      );
    });
  });

  describe('PermissionGuard', () => {
    it('answers 403 FORBIDDEN without the permission, 2xx with it', async () => {
      const ops = await world.addMember(tenant, { role: 'operations' });
      const sales = await world.addMember(tenant, { role: 'sales_agent' });

      // customer.manage: Sales agent has it, Operations does not.
      const denied = await t
        .http()
        .post('/v1/_access/write')
        .set(t.as(authHeader(ops.userId, tenant.id)));
      expect(denied.status).toBe(403);
      expect(body(denied)).toBe('FORBIDDEN');
      const allowed = await t
        .http()
        .post('/v1/_access/write')
        .set(t.as(authHeader(sales.userId, tenant.id)));
      expect(allowed.status).toBe(201);
    });

    it('applies a role edit on the very next request (nothing is cached)', async () => {
      const m = await world.addMember(tenant, { role: { permissions: ['customer.manage'] } });
      const auth = t.as(authHeader(m.userId, tenant.id));
      expect((await t.http().post('/v1/_access/write').set(auth)).status).toBe(201);

      await world.setRolePermissions(tenant, m.roleId, ['customer.view']);
      expect((await t.http().post('/v1/_access/write').set(auth)).status).toBe(403);

      await world.setRolePermissions(tenant, m.roleId, ['customer.manage']);
      expect((await t.http().post('/v1/_access/write').set(auth)).status).toBe(201);
    });

    it('ignores permission names a role holds that no longer exist', async () => {
      const m = await world.addMember(tenant, {
        role: { permissions: ['customer.manage', 'made.up' as never] },
      });
      const res = await t.http().get('/v1/_access/read').set(authHeader(m.userId, tenant.id));
      expect(res.status).toBe(403); // customer.view is not held
      const ok = await t
        .http()
        .post('/v1/_access/write')
        .set(t.as(authHeader(m.userId, tenant.id)));
      expect(ok.status).toBe(201);
    });
  });

  describe('EntitlementGuard (starter plan: 1 venue, 3 spaces, 5 users)', () => {
    it('allows a create below the limit and answers 402 PLAN_LIMIT_REACHED at it', async () => {
      const t1 = await world.createTenant({ plan: 'starter' });
      const m = await world.addMember(t1, { role: 'owner' });
      const auth = t.as(authHeader(m.userId, t1.id));

      expect((await t.http().post('/v1/_access/venue').set(auth)).status).toBe(201);
      await world.createVenue(t1);
      const res = await t.http().post('/v1/_access/venue').set(auth);
      expect(res.status).toBe(402);
      expect(body(res)).toBe('PLAN_LIMIT_REACHED');
      expect(res.body.error.details).toEqual({ resource: 'maxVenues', limit: 1, used: 1 });
    });

    it('does not count inactive venues', async () => {
      const t1 = await world.createTenant({ plan: 'starter' });
      const m = await world.addMember(t1, { role: 'owner' });
      await world.createVenue(t1, { active: false });
      const res = await t
        .http()
        .post('/v1/_access/venue')
        .set(t.as(authHeader(m.userId, t1.id)));
      expect(res.status).toBe(201);
    });

    it("uses the limit of the tenant's own plan", async () => {
      const t1 = await world.createTenant({ plan: 'growth' }); // 3 venues
      const m = await world.addMember(t1, { role: 'owner' });
      await world.createVenue(t1);
      await world.createVenue(t1);
      const auth = t.as(authHeader(m.userId, t1.id));
      expect((await t.http().post('/v1/_access/venue').set(auth)).status).toBe(201);
      await world.createVenue(t1);
      expect((await t.http().post('/v1/_access/venue').set(auth)).status).toBe(402);
    });

    it('counts active memberships against maxUsers', async () => {
      const t1 = await world.createTenant({ plan: 'starter' }); // 5 users
      const owner = await world.addMember(t1, { role: 'owner' });
      for (let i = 0; i < 3; i++) await world.addMember(t1, { role: 'operations' });
      await world.addMember(t1, { role: 'operations', active: false }); // does not count
      const auth = t.as(authHeader(owner.userId, t1.id));
      expect((await t.http().post('/v1/_access/user').set(auth)).status).toBe(201); // 4 of 5
      await world.addMember(t1, { role: 'operations' }); // now 5 of 5
      const res = await t.http().post('/v1/_access/user').set(auth);
      expect(res.status).toBe(402);
      expect(res.body.error.details).toMatchObject({ resource: 'maxUsers', limit: 5, used: 5 });
    });

    it('answers 402 when the tenant has no subscription at all', async () => {
      const t1 = await world.createTenant({ plan: null });
      const m = await world.addMember(t1, { role: 'owner' });
      const res = await t
        .http()
        .post('/v1/_access/space')
        .set(t.as(authHeader(m.userId, t1.id)));
      expect(res.status).toBe(402);
      expect(body(res)).toBe('PLAN_LIMIT_REACHED');
    });

    it('is checked after the permission: no permission answers 403, not 402', async () => {
      const t1 = await world.createTenant({ plan: 'starter' });
      await world.createVenue(t1);
      const m = await world.addMember(t1, { role: 'operations' });
      const res = await t
        .http()
        .post('/v1/_access/venue')
        .set(t.as(authHeader(m.userId, t1.id)));
      expect(res.status).toBe(403);
    });
  });

  describe('venue scoping', () => {
    it('lets an unrestricted member (empty venueIds) see any venue and filter by a requested one', async () => {
      const m = await world.addMember(tenant, { role: 'owner' });
      const auth = authHeader(m.userId, tenant.id);
      expect((await t.http().get('/v1/_access/venues/ven_any').set(auth)).status).toBe(200);
      const all = await t.http().get('/v1/_access/venues').set(auth);
      expect(all.body).toEqual({ filter: null, unrestricted: true });
      const one = await t.http().get('/v1/_access/venues?venueId=ven_x').set(auth);
      expect(one.body.filter).toEqual(['ven_x']);
    });

    it('limits a venue-scoped member to their venues; other venues answer 404', async () => {
      const mine = await world.createVenue(tenant);
      const notMine = await world.createVenue(tenant);
      const m = await world.addMember(tenant, {
        role: { permissions: ['venue.manage'] },
        venueIds: [mine],
      });
      const auth = authHeader(m.userId, tenant.id);

      expect((await t.http().get(`/v1/_access/venues/${mine}`).set(auth)).status).toBe(200);
      const denied = await t.http().get(`/v1/_access/venues/${notMine}`).set(auth);
      expect(denied.status).toBe(404);
      expect(body(denied)).toBe('NOT_FOUND');
    });

    it('never widens scope from a client-supplied venueId; it only narrows', async () => {
      const mine = await world.createVenue(tenant);
      const notMine = await world.createVenue(tenant);
      const m = await world.addMember(tenant, {
        role: { permissions: ['venue.manage'] },
        venueIds: [mine],
      });
      const auth = authHeader(m.userId, tenant.id);

      expect((await t.http().get('/v1/_access/venues').set(auth)).body.filter).toEqual([mine]);
      expect(
        (await t.http().get(`/v1/_access/venues?venueId=${mine}`).set(auth)).body.filter,
      ).toEqual([mine]);
      expect(
        (await t.http().get(`/v1/_access/venues?venueId=${notMine}`).set(auth)).body.filter,
      ).toEqual([]);
    });
  });
});
