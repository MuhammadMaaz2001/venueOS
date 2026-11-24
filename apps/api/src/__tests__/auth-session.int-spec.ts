import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthHarness,
  SESSION_COOKIE,
  TEST_ENV,
  TEST_PASSWORD,
  freshIp,
} from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// Sessions: the real AuthContextProvider (cookie -> auth_sessions), lifetime, rotation, revocation, and the
// @AuthenticatedOnly() endpoints (/me, /me/tenants, /me/switch-tenant, logout, password change).

describe('sessions', () => {
  let t: TestApp;
  let h: AuthHarness;
  let world: World;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    t = await createTestApp({ env: TEST_ENV, realAuth: true });
    h = new AuthHarness();
    world = new World();
    tenant = await world.createTenant();
    other = await world.createTenant();
  });
  afterAll(async () => {
    await t.app.close();
    await h.close();
    await world.close();
  });

  const me = (cookie: string) => t.http().get('/v1/me').set('Cookie', cookie);
  const idOf = async (cookie: string) => (await h.sessionRow(cookie))?.id as string;

  async function loggedIn(options: Parameters<World['addMember']>[1] = { role: 'owner' }) {
    const member = await h.member(world, tenant, options);
    const res = await h.login(t, member.email);
    return {
      member,
      cookie: h.cookieOf(res),
      headers: { ...t.csrfHeaders, Cookie: h.cookieOf(res) },
    };
  }

  describe('the provider', () => {
    it('no cookie, an unknown token and garbage: 401 UNAUTHENTICATED, nothing more said', async () => {
      for (const send of [
        () => t.http().get('/v1/me'),
        () =>
          t
            .http()
            .get('/v1/me')
            .set('Cookie', `${SESSION_COOKIE}=${'A'.repeat(43)}`),
        () => t.http().get('/v1/me').set('Cookie', `${SESSION_COOKIE}=not-a-token`),
        () => t.http().get('/v1/me').set('Cookie', `${SESSION_COOKIE}=`),
        () =>
          t
            .http()
            .get('/v1/me')
            .set('Cookie', 'vos_session=' + 'A'.repeat(43)),
      ]) {
        const res = await send();
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('identity only comes from the cookie: a header, a query string or a body cannot authenticate', async () => {
      const { cookie } = await loggedIn();
      const token = h.tokenOfCookie(cookie);
      const res = await t
        .http()
        .get(`/v1/me?session=${token}&token=${token}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Session', token);
      expect(res.status).toBe(401);
    });

    it('a valid cookie authenticates; a revoked one is 401 UNAUTHENTICATED', async () => {
      const { cookie } = await loggedIn();
      expect((await me(cookie)).status).toBe(200);
      await h.sql(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, [
        await idOf(cookie),
      ]);
      const res = await me(cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('idle for more than 12 hours: 401 SESSION_EXPIRED, and the dead cookie is cleared', async () => {
      const { cookie } = await loggedIn();
      await h.sql(
        `UPDATE auth_sessions SET last_seen_at = now() - interval '12 hours 1 minute' WHERE id = $1`,
        [await idOf(cookie)],
      );
      const res = await me(cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_EXPIRED');
      const cleared = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(`${SESSION_COOKIE}=;`),
      );
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Path=/');
    });

    it('older than 30 days (absolute): 401 SESSION_EXPIRED even if it was used a second ago', async () => {
      const { cookie } = await loggedIn();
      await h.sql(
        `UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [await idOf(cookie)],
      );
      const res = await me(cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_EXPIRED');
    });

    it('just inside the idle limit still works', async () => {
      const { cookie } = await loggedIn();
      await h.sql(
        `UPDATE auth_sessions SET last_seen_at = now() - interval '11 hours 59 minutes' WHERE id = $1`,
        [await idOf(cookie)],
      );
      expect((await me(cookie)).status).toBe(200);
    });

    it('slides last_seen_at, but writes it at most once a minute', async () => {
      const { cookie } = await loggedIn();
      const id = await idOf(cookie);
      await h.sql(
        `UPDATE auth_sessions SET last_seen_at = now() - interval '2 minutes' WHERE id = $1`,
        [id],
      );
      const before = (await h.sessionRow(cookie))!.lastSeenAt.getTime();
      expect((await me(cookie)).status).toBe(200);
      const slid = (await h.sessionRow(cookie))!.lastSeenAt.getTime();
      expect(slid).toBeGreaterThan(before + 60_000);

      await h.sql(
        `UPDATE auth_sessions SET last_seen_at = now() - interval '10 seconds' WHERE id = $1`,
        [id],
      );
      const recent = (await h.sessionRow(cookie))!.lastSeenAt.getTime();
      expect((await me(cookie)).status).toBe(200);
      expect((await h.sessionRow(cookie))!.lastSeenAt.getTime()).toBe(recent);
    });

    it('does not extend the absolute lifetime by use', async () => {
      const { cookie } = await loggedIn();
      const before = (await h.sessionRow(cookie))!.expiresAt.getTime();
      await h.sql(
        `UPDATE auth_sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`,
        [await idOf(cookie)],
      );
      await me(cookie);
      expect((await h.sessionRow(cookie))!.expiresAt.getTime()).toBe(before);
    });
  });

  describe('GET /v1/me and GET /v1/me/tenants', () => {
    it('says who I am and what I may do in the active workspace', async () => {
      const { member, cookie } = await loggedIn({ role: 'sales_agent' });
      const res = await me(cookie);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        id: member.userId,
        email: member.email,
        emailVerified: true,
      });
      expect(res.body.activeTenantId).toBe(tenant.id);
      expect(res.body.access).toMatchObject({
        tenantId: tenant.id,
        roleName: 'Sales agent',
        venueIds: [],
      });
      expect(res.body.access.permissions).toContain('booking.create');
      expect(res.body.access.permissions).not.toContain('role.manage');
      expect(res.body.access.limits).toEqual({ maxDiscountPct: 5 });
    });

    it('works before a workspace is chosen (no tenant needed), with access null', async () => {
      const member = await h.member(world, tenant);
      await world.addMember(other, { userId: member.userId });
      const res = await h.login(t, member.email);
      expect(res.body.activeTenantId).toBeNull();
      const cookie = h.cookieOf(res);
      const mine = await me(cookie);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ activeTenantId: null, access: null });
      // But a tenant route is refused until a workspace is chosen.
      const roles = await t.http().get('/v1/roles').set('Cookie', cookie);
      expect(roles.status).toBe(403);
    });

    it('lists only my ACTIVE memberships', async () => {
      const { member, cookie } = await loggedIn();
      const stranger = await world.createTenant();
      const inactive = await world.addMember(stranger, { userId: member.userId, active: false });
      expect(inactive.userId).toBe(member.userId);

      const res = await t.http().get('/v1/me/tenants').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([tenant.id]);
      expect(res.body.activeTenantId).toBe(tenant.id);
      expect(res.body.data[0]).toMatchObject({
        id: tenant.id,
        status: 'ACTIVE',
        country: 'PK',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
      });
    });

    it('reports no access when my membership in the active workspace was deactivated', async () => {
      const { member, cookie } = await loggedIn();
      await h.sql(`UPDATE memberships SET active = false WHERE user_id = $1 AND tenant_id = $2`, [
        member.userId,
        tenant.id,
      ]);
      const res = await me(cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ activeTenantId: null, access: null });
      expect((await t.http().get('/v1/roles').set('Cookie', cookie)).status).toBe(403);
    });
  });

  describe('POST /v1/me/switch-tenant', () => {
    async function twoWorkspaces() {
      const member = await h.member(world, tenant, { role: 'owner' });
      await world.addMember(other, { userId: member.userId, role: 'branch_manager' });
      const login = await h.login(t, member.email);
      return { member, cookie: h.cookieOf(login) };
    }

    it('sets the workspace and ROTATES the token: the old cookie dies, the row stays', async () => {
      const { member, cookie } = await twoWorkspaces();
      const id = await idOf(cookie);

      const res = await t
        .http()
        .post('/v1/me/switch-tenant')
        .set(t.csrfHeaders)
        .set('Cookie', cookie)
        .send({ tenantId: other.id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ activeTenantId: other.id });
      expect(res.body.access).toMatchObject({ tenantId: other.id, roleName: 'Branch manager' });
      const next = h.cookieOf(res);
      expect(next).not.toBe(cookie);

      expect((await me(cookie)).status).toBe(401); // the old token is gone
      const fresh = await me(next);
      expect(fresh.status).toBe(200);
      expect(fresh.body.activeTenantId).toBe(other.id);
      expect(await idOf(next)).toBe(id);
      expect((await h.sessionRow(next))?.activeTenantId).toBe(other.id);
      expect((await h.sessionRow(next))?.userId).toBe(member.userId);
    });

    it("another tenant's id, or one that does not exist: 404, and nothing changes", async () => {
      const { cookie } = await twoWorkspaces();
      const stranger = await world.createTenant();
      for (const tenantId of [stranger.id, 'no-such-tenant']) {
        const res = await t
          .http()
          .post('/v1/me/switch-tenant')
          .set(t.csrfHeaders)
          .set('Cookie', cookie)
          .send({ tenantId });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect((await me(cookie)).status).toBe(200); // the token was not rotated
    });

    it('refuses a deactivated membership (404), validates the body (400), needs a login (401) and CSRF (403)', async () => {
      const { member, cookie } = await twoWorkspaces();
      await h.sql(`UPDATE memberships SET active = false WHERE user_id = $1 AND tenant_id = $2`, [
        member.userId,
        other.id,
      ]);
      const send = (headers: Record<string, string>, body: object) =>
        t.http().post('/v1/me/switch-tenant').set(headers).send(body);
      expect(
        (await send({ ...t.csrfHeaders, Cookie: cookie }, { tenantId: other.id })).status,
      ).toBe(404);
      expect((await send({ ...t.csrfHeaders, Cookie: cookie }, {})).status).toBe(400);
      expect((await send(t.csrfHeaders, { tenantId: tenant.id })).status).toBe(401);
      expect((await send({ Cookie: cookie }, { tenantId: tenant.id })).status).toBe(403);
    });
  });

  describe('logout', () => {
    it('POST /v1/auth/logout revokes this session only and clears the cookie (204)', async () => {
      const member = await h.member(world, tenant);
      const a = h.cookieOf(await h.login(t, member.email));
      const b = h.cookieOf(await h.login(t, member.email));
      const res = await t.http().post('/v1/auth/logout').set(t.csrfHeaders).set('Cookie', a);
      expect(res.status).toBe(204);
      expect(
        (res.headers['set-cookie'] as unknown as string[]).some((c) =>
          c.startsWith(`${SESSION_COOKIE}=;`),
        ),
      ).toBe(true);
      expect((await h.sessionRow(a))?.revokedAt).not.toBeNull();
      expect((await me(a)).status).toBe(401);
      expect((await me(b)).status).toBe(200);
    });

    it('POST /v1/auth/logout-all revokes every session of the user, and nobody elses', async () => {
      const member = await h.member(world, tenant);
      const bystander = await h.member(world, tenant);
      const a = h.cookieOf(await h.login(t, member.email));
      const b = h.cookieOf(await h.login(t, member.email));
      const c = h.cookieOf(await h.login(t, bystander.email));
      const res = await t.http().post('/v1/auth/logout-all').set(t.csrfHeaders).set('Cookie', a);
      expect(res.status).toBe(204);
      expect((await me(a)).status).toBe(401);
      expect((await me(b)).status).toBe(401);
      expect((await me(c)).status).toBe(200);
    });

    it('needs a login (401) and the CSRF headers (403)', async () => {
      const { cookie } = await loggedIn();
      expect((await t.http().post('/v1/auth/logout').set(t.csrfHeaders)).status).toBe(401);
      expect((await t.http().post('/v1/auth/logout-all').set(t.csrfHeaders)).status).toBe(401);
      expect((await t.http().post('/v1/auth/logout').set('Cookie', cookie)).status).toBe(403);
      expect((await t.http().post('/v1/auth/logout-all').set('Cookie', cookie)).status).toBe(403);
      expect((await me(cookie)).status).toBe(200);
    });
  });

  describe('POST /v1/auth/password/change', () => {
    const NEW_PASSWORD = 'an entirely new passphrase 91';
    const change = (headers: Record<string, string>, body: Record<string, unknown>) =>
      t.http().post('/v1/auth/password/change').set(headers).send(body);

    it('sets the new password and revokes the OTHER sessions, keeping this one (204)', async () => {
      const member = await h.member(world, tenant);
      const here = h.cookieOf(await h.login(t, member.email));
      const elsewhere = h.cookieOf(await h.login(t, member.email));

      const res = await change(
        { ...t.csrfHeaders, Cookie: here },
        { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
      );
      expect(res.status).toBe(204);
      expect((await me(here)).status).toBe(200);
      expect((await me(elsewhere)).status).toBe(401);
      expect((await h.login(t, member.email, TEST_PASSWORD)).status).toBe(401);
      expect((await h.login(t, member.email, NEW_PASSWORD)).status).toBe(200);
      const credentials = await h.authDb.client.userCredential.findUniqueOrThrow({
        where: { userId: member.userId },
      });
      expect(credentials.passwordChangedAt).not.toBeNull();
    });

    it('a wrong current password is 403 and counts toward the lock', async () => {
      const member = await h.member(world, tenant);
      const headers = { ...t.csrfHeaders, Cookie: h.cookieOf(await h.login(t, member.email)) };
      for (let i = 0; i < 5; i++) {
        const res = await change(headers, {
          currentPassword: `wrong ${i} wrong ${i}`,
          newPassword: NEW_PASSWORD,
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      // Locked: even the right current password is refused, and logging in fails too.
      const locked = await change(headers, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(locked.status).toBe(403);
      expect((await h.login(t, member.email)).status).toBe(401);
    });

    it('validates the new password (400, including breached ones), needs a login (401) and CSRF (403)', async () => {
      const { headers } = await loggedIn();
      expect(
        (await change(headers, { currentPassword: TEST_PASSWORD, newPassword: 'short' })).status,
      ).toBe(400);
      const breached = await change(headers, {
        currentPassword: TEST_PASSWORD,
        newPassword: 'qwertyuiop',
      });
      expect(breached.status).toBe(400);
      expect(breached.body.error.details[0].path).toBe('newPassword');
      expect(
        (await change(t.csrfHeaders, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
          .status,
      ).toBe(401);
      expect(
        (
          await change(
            { Cookie: headers.Cookie },
            { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
          )
        ).status,
      ).toBe(403);
    });
  });

  it('a new login from another address creates a separate session (the old one keeps working)', async () => {
    const member = await h.member(world, tenant);
    const a = h.cookieOf(await h.login(t, member.email, TEST_PASSWORD, freshIp()));
    const b = h.cookieOf(await h.login(t, member.email, TEST_PASSWORD, freshIp()));
    expect(a).not.toBe(b);
    expect((await me(a)).status).toBe(200);
    expect((await me(b)).status).toBe(200);
  });
});
