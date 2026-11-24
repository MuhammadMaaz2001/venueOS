import { DEFAULT_ROLES } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../modules/auth/auth.constants';
import { AuthHarness, TEST_ENV, TEST_PASSWORD, freshIp, uniqueEmail } from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// Staff invitations: create / list / revoke (staff.manage) and accept (new user, existing user).

describe('staff invitations', () => {
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

  /** A tenant with an owner who is logged in. */
  async function workspace(plan: 'starter' | 'growth' = 'growth') {
    const tenant = await world.createTenant({ plan });
    const owner = await h.member(world, tenant, { role: 'owner' });
    const headers = await h.sessionHeaders(t, owner.email);
    return { tenant, owner, headers };
  }

  const invite = (headers: Record<string, string>, body: Record<string, unknown>) =>
    t.http().post('/v1/staff/invitations').set(headers).send(body);

  describe('POST /v1/staff/invitations', () => {
    it('creates the invitation (201), audits it and queues the mail with a sealed link', async () => {
      const { tenant, owner, headers } = await workspace();
      const venue = await world.createVenue(tenant);
      const email = uniqueEmail('invitee');

      const res = await invite(headers, {
        email,
        roleId: tenant.roles.sales_agent,
        venueIds: [venue],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        email,
        roleId: tenant.roles.sales_agent,
        roleName: 'Sales agent',
        venueIds: [venue],
        status: 'pending',
      });
      const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThan(72.1);

      const mail = await h.lastMail(email, 'staff.invite');
      expect(mail.tenantId).toBe(tenant.id);
      expect(mail.vars).toMatchObject({
        inviterName: 'Test User',
        roleName: 'Sales agent',
        days: 3,
      });
      expect(String(mail.vars.acceptUrl)).toMatch(
        /^http:\/\/localhost:3000\/accept-invite\?token=[\w-]{43}$/,
      );
      expect(JSON.stringify(mail.storedVars)).not.toContain(mail.token as string);

      // Only the hash of the token is stored.
      const row = await h.authDb.client.invitation.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.tokenHash).toBe(hashToken(mail.token as string));
      expect(row.invitedById).toBe(owner.userId);
      expect(await world.auditRows(tenant, { action: 'staff.invite' })).toHaveLength(1);
    });

    it('validates the body (400)', async () => {
      const { tenant, headers } = await workspace();
      for (const body of [
        {},
        { email: 'nope', roleId: tenant.roles.sales_agent },
        { email: uniqueEmail(), roleId: '' },
        { email: uniqueEmail(), roleId: tenant.roles.sales_agent, venueIds: 'all' },
      ]) {
        const res = await invite(headers, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('needs a login (401), staff.manage (403) and the CSRF headers (403)', async () => {
      const { tenant, headers } = await workspace();
      const viewer = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      const viewerHeaders = await h.sessionHeaders(t, viewer.email);
      const body = { email: uniqueEmail(), roleId: tenant.roles.sales_agent };

      expect((await invite(t.csrfHeaders, body)).status).toBe(401);
      expect((await invite(viewerHeaders, body)).status).toBe(403);
      expect((await invite({ Cookie: headers.Cookie as string }, body)).status).toBe(403);
      expect(await h.count('invitations', 'tenant_id = $1', [tenant.id])).toBe(0);
    });

    it("another tenant's role or venue: 404, nothing is created", async () => {
      const { tenant, headers } = await workspace();
      const stranger = await world.createTenant();
      const strangerVenue = await world.createVenue(stranger);

      const role = await invite(headers, { email: uniqueEmail(), roleId: stranger.roles.owner });
      expect(role.status).toBe(404);
      const venue = await invite(headers, {
        email: uniqueEmail(),
        roleId: tenant.roles.sales_agent,
        venueIds: [strangerVenue],
      });
      expect(venue.status).toBe(404);
      expect(await h.count('invitations', 'tenant_id = $1', [tenant.id])).toBe(0);
    });

    it('cannot invite into a role with permissions the caller lacks (403, escalation)', async () => {
      const { tenant } = await workspace();
      const manager = await h.member(world, tenant, {
        role: { permissions: ['staff.manage', 'customer.view'] },
      });
      const headers = await h.sessionHeaders(t, manager.email);
      const ok = await invite(headers, {
        email: uniqueEmail(),
        roleId: await rolePermittedTo(tenant, ['customer.view']),
      });
      expect(ok.status).toBe(201);
      const denied = await invite(headers, { email: uniqueEmail(), roleId: tenant.roles.owner });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      const higher = await invite(headers, {
        email: uniqueEmail(),
        roleId: tenant.roles.sales_agent,
      });
      expect(higher.status).toBe(403); // sales agent holds booking.* the manager does not
    });

    async function rolePermittedTo(tenant: TestTenant, permissions: string[]): Promise<string> {
      return world.db.tx({ tenantId: tenant.id }, async (tx) => {
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            name: `custom ${Math.random()}`,
            permissions,
            limits: { maxDiscountPct: 0 },
          },
        });
        return role.id;
      });
    }

    it('a caller limited to some venues invites only into those venues, never "all venues"', async () => {
      const { tenant } = await workspace();
      const mine = await world.createVenue(tenant);
      const theirs = await world.createVenue(tenant);
      const manager = await h.member(world, tenant, {
        role: { permissions: ['staff.manage', 'customer.view'] },
        venueIds: [mine],
      });
      const headers = await h.sessionHeaders(t, manager.email);
      const roleId = await rolePermittedTo(tenant, ['customer.view']);

      expect((await invite(headers, { email: uniqueEmail(), roleId, venueIds: [] })).status).toBe(
        403,
      );
      expect(
        (await invite(headers, { email: uniqueEmail(), roleId, venueIds: [theirs] })).status,
      ).toBe(403);
      expect(
        (await invite(headers, { email: uniqueEmail(), roleId, venueIds: [mine, theirs] })).status,
      ).toBe(403);
      expect(
        (await invite(headers, { email: uniqueEmail(), roleId, venueIds: [mine] })).status,
      ).toBe(201);
    });

    it('a venue-limited Branch manager (with staff.manage) invites only into their own venues: "all venues" is refused', async () => {
      const { tenant } = await workspace();
      const mine = await world.createVenue(tenant);
      const theirs = await world.createVenue(tenant);
      // The default Branch manager role has no staff.manage; a tenant grants it by copying the role.
      const branchManager = DEFAULT_ROLES.find((r) => r.key === 'branch_manager');
      if (!branchManager) throw new Error('missing default role');
      const manager = await h.member(world, tenant, {
        role: {
          name: 'Branch manager + staff',
          permissions: [...branchManager.permissions, 'staff.manage'],
          limits: branchManager.limits,
        },
        venueIds: [mine],
      });
      const headers = await h.sessionHeaders(t, manager.email);
      const roleId = tenant.roles.sales_agent;

      // What the web app sends by default: the inviter's own scope.
      const own = await invite(headers, { email: uniqueEmail(), roleId, venueIds: [mine] });
      expect(own.status).toBe(201);
      expect(own.body.venueIds).toEqual([mine]);
      // Never "all venues", never a venue outside the scope.
      expect((await invite(headers, { email: uniqueEmail(), roleId })).status).toBe(403);
      expect((await invite(headers, { email: uniqueEmail(), roleId, venueIds: [] })).status).toBe(
        403,
      );
      expect(
        (await invite(headers, { email: uniqueEmail(), roleId, venueIds: [theirs] })).status,
      ).toBe(403);
    });

    it('refuses a second pending invitation for the address (409) and an existing active member (409)', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      const body = { email, roleId: tenant.roles.sales_agent };
      expect((await invite(headers, body)).status).toBe(201);
      const again = await invite(headers, body);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('DUPLICATE');

      const member = await h.member(world, tenant);
      const existing = await invite(headers, {
        email: member.email,
        roleId: tenant.roles.sales_agent,
      });
      expect(existing.status).toBe(409);
    });

    it('an EXPIRED invitation does not block a new one (it is revoked first)', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      const first = await invite(headers, { email, roleId: tenant.roles.sales_agent });
      await h.sql(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
        first.body.id,
      ]);
      const second = await invite(headers, { email, roleId: tenant.roles.sales_agent });
      expect(second.status).toBe(201);
      const old = await h.authDb.client.invitation.findUniqueOrThrow({
        where: { id: first.body.id },
      });
      expect(old.revokedAt).not.toBeNull();
    });

    it('pending invitations count toward the plan limit (starter: 5 users) -> 402', async () => {
      const { tenant, headers } = await workspace('starter');
      for (let i = 0; i < 3; i++) await h.member(world, tenant); // owner + 3 = 4 of 5
      const first = await invite(headers, {
        email: uniqueEmail(),
        roleId: tenant.roles.sales_agent,
      });
      expect(first.status).toBe(201); // the fifth seat is now reserved by this invitation
      const second = await invite(headers, {
        email: uniqueEmail(),
        roleId: tenant.roles.sales_agent,
      });
      expect(second.status).toBe(402);
      expect(second.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(second.body.error.details).toMatchObject({ resource: 'maxUsers', limit: 5 });

      // Revoking frees the seat again.
      await t.http().delete(`/v1/staff/invitations/${first.body.id}`).set(headers);
      expect(
        (await invite(headers, { email: uniqueEmail(), roleId: tenant.roles.sales_agent })).status,
      ).toBe(201);
    });

    it('cannot slip past the limit with parallel requests', async () => {
      const { tenant, headers } = await workspace('starter');
      for (let i = 0; i < 2; i++) await h.member(world, tenant); // 3 of 5
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          invite(headers, { email: uniqueEmail(), roleId: tenant.roles.sales_agent }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    });
  });

  describe('GET /v1/staff/invitations and DELETE /v1/staff/invitations/:id', () => {
    it('lists the pending invitations of THIS tenant only', async () => {
      const a = await workspace();
      const b = await workspace();
      const mine = await invite(a.headers, {
        email: uniqueEmail(),
        roleId: a.tenant.roles.sales_agent,
      });
      await invite(b.headers, { email: uniqueEmail(), roleId: b.tenant.roles.sales_agent });

      const res = await t.http().get('/v1/staff/invitations').set(a.headers);
      expect(res.status).toBe(200);
      expect(res.body.data.map((i: { id: string }) => i.id)).toEqual([mine.body.id]);
      expect(res.body.data[0]).toMatchObject({ status: 'pending', roleName: 'Sales agent' });
      expect(res.body.nextCursor).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('token');

      await h.sql(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
        mine.body.id,
      ]);
      const expired = await t.http().get('/v1/staff/invitations').set(a.headers);
      expect(expired.body.data[0].status).toBe('expired');
    });

    it('needs staff.manage (403) and a login (401)', async () => {
      const { tenant } = await workspace();
      const viewer = await h.member(world, tenant, { role: { permissions: ['customer.view'] } });
      expect(
        (
          await t
            .http()
            .get('/v1/staff/invitations')
            .set(await h.sessionHeaders(t, viewer.email))
        ).status,
      ).toBe(403);
      expect((await t.http().get('/v1/staff/invitations')).status).toBe(401);
    });

    it('revokes (204) with an audit row; the link no longer works; revoking again is fine', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      const created = await invite(headers, { email, roleId: tenant.roles.sales_agent });
      const token = (await h.lastMail(email, 'staff.invite')).token as string;

      const res = await t.http().delete(`/v1/staff/invitations/${created.body.id}`).set(headers);
      expect(res.status).toBe(204);
      expect(
        (await t.http().delete(`/v1/staff/invitations/${created.body.id}`).set(headers)).status,
      ).toBe(204);
      expect(await world.auditRows(tenant, { action: 'staff.invite.revoke' })).toHaveLength(1);
      expect((await t.http().get('/v1/staff/invitations').set(headers)).body.data).toEqual([]);

      const accept = await t
        .http()
        .post('/v1/auth/invitations/accept')
        .set(t.csrfHeaders)
        .send({ token, name: 'Late', password: TEST_PASSWORD });
      expect(accept.status).toBe(400);
    });

    it("another tenant's invitation or an unknown id: 404, and it stays valid", async () => {
      const a = await workspace();
      const b = await workspace();
      const theirs = await invite(b.headers, {
        email: uniqueEmail(),
        roleId: b.tenant.roles.sales_agent,
      });

      for (const id of [theirs.body.id, 'no-such-invitation']) {
        const res = await t.http().delete(`/v1/staff/invitations/${id}`).set(a.headers);
        expect(res.status).toBe(404);
      }
      const row = await h.authDb.client.invitation.findUniqueOrThrow({
        where: { id: theirs.body.id },
      });
      expect(row.revokedAt).toBeNull();
    });

    it('an accepted invitation cannot be revoked (422); the CSRF headers are required (403)', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      const created = await invite(headers, { email, roleId: tenant.roles.sales_agent });
      const token = (await h.lastMail(email, 'staff.invite')).token as string;
      await t
        .http()
        .post('/v1/auth/invitations/accept')
        .set(t.csrfHeaders)
        .send({ token, name: 'New Person', password: TEST_PASSWORD });

      const res = await t.http().delete(`/v1/staff/invitations/${created.body.id}`).set(headers);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(
        (
          await t
            .http()
            .delete(`/v1/staff/invitations/${created.body.id}`)
            .set({ Cookie: headers.Cookie as string })
        ).status,
      ).toBe(403);
    });
  });

  describe('POST /v1/auth/invitations/accept (a new user)', () => {
    const accept = (body: Record<string, unknown>) =>
      t
        .http()
        .post('/v1/auth/invitations/accept')
        .set(t.csrfHeaders)
        .set('X-Forwarded-For', freshIp())
        .send(body);

    it('creates the account (address verified by the token), the membership with the invited role and venues, and audits it', async () => {
      const { tenant, headers } = await workspace();
      const venue = await world.createVenue(tenant);
      const email = uniqueEmail();
      const created = await invite(headers, {
        email,
        roleId: tenant.roles.accountant,
        venueIds: [venue],
      });
      const token = (await h.lastMail(email, 'staff.invite')).token as string;

      const res = await accept({ token, name: 'New Accountant', password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: tenant.id });

      const user = await h.authDb.client.user.findUniqueOrThrow({
        where: { email },
        include: { credentials: true },
      });
      expect(user.name).toBe('New Accountant');
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.credentials?.passwordHash).toMatch(/^\$argon2id\$/);
      const membership = await world.db.tx({ tenantId: tenant.id, userId: user.id }, (tx) =>
        tx.membership.findFirstOrThrow({ where: { tenantId: tenant.id, userId: user.id } }),
      );
      expect(membership).toMatchObject({
        roleId: tenant.roles.accountant,
        venueIds: [venue],
        active: true,
      });
      const audit = await world.auditRows(tenant, { action: 'staff.invite.accept' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'USER',
        actorUserId: user.id,
        entityId: created.body.id,
      });

      // They can log in and are in the workspace with that role.
      const login = await h.login(t, email);
      expect(login.status).toBe(200);
      expect(login.body.activeTenantId).toBe(tenant.id);
      const mine = await t.http().get('/v1/me').set('Cookie', h.cookieOf(login));
      expect(mine.body.access).toMatchObject({ roleName: 'Accountant', venueIds: [venue] });
    });

    it('is single-use, also under a race; an expired or unknown token is the same 400', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      await invite(headers, { email, roleId: tenant.roles.sales_agent });
      const token = (await h.lastMail(email, 'staff.invite')).token as string;
      const results = await Promise.all([
        accept({ token, name: 'One', password: TEST_PASSWORD }),
        accept({ token, name: 'Two', password: TEST_PASSWORD }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await h.authDb.client.user.count({ where: { email } })).toBe(1);

      const second = uniqueEmail();
      const created = await invite(headers, { email: second, roleId: tenant.roles.sales_agent });
      const expiredToken = (await h.lastMail(second, 'staff.invite')).token as string;
      await h.sql(`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        created.body.id,
      ]);
      const expired = await accept({ token: expiredToken, name: 'Late', password: TEST_PASSWORD });
      const unknown = await accept({
        token: 'C'.repeat(43),
        name: 'Nobody',
        password: TEST_PASSWORD,
      });
      expect([expired.status, expired.body.error.message]).toEqual([
        unknown.status,
        unknown.body.error.message,
      ]);
      expect(expired.status).toBe(400);
    });

    it('an address that already has an account gets 409 (log in and use the other endpoint); nothing is consumed', async () => {
      const { tenant, headers } = await workspace();
      const person = await h.member(world, await world.createTenant());
      await invite(headers, { email: person.email, roleId: tenant.roles.sales_agent });
      const token = (await h.lastMail(person.email, 'staff.invite')).token as string;

      const res = await accept({ token, name: 'Imposter', password: 'a different passphrase 1' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: person.email } });
      expect(user.name).toBe('Test User'); // untouched
      expect((await h.login(t, person.email, TEST_PASSWORD)).status).toBe(200); // password untouched
      const row = await h.authDb.client.invitation.findFirstOrThrow({
        where: { tenantId: tenant.id, email: person.email },
      });
      expect(row.acceptedAt).toBeNull();
    });

    it('applies the password policy (400) without consuming the invitation, and validates the body', async () => {
      const { tenant, headers } = await workspace();
      const email = uniqueEmail();
      await invite(headers, { email, roleId: tenant.roles.sales_agent });
      const token = (await h.lastMail(email, 'staff.invite')).token as string;

      expect((await accept({ token, name: 'New', password: 'short' })).status).toBe(400);
      expect((await accept({ token, name: 'New', password: 'qwertyuiop' })).status).toBe(400);
      expect((await accept({ token, name: '', password: TEST_PASSWORD })).status).toBe(400);
      expect((await accept({ name: 'New', password: TEST_PASSWORD })).status).toBe(400);
      expect((await accept({ token, name: 'New', password: TEST_PASSWORD })).status).toBe(200);
    });

    it('needs the CSRF headers (403)', async () => {
      const res = await t
        .http()
        .post('/v1/auth/invitations/accept')
        .send({ token: 'A'.repeat(43), name: 'x', password: TEST_PASSWORD });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /v1/me/invitations/accept (an existing user)', () => {
    async function invited(plan: 'starter' | 'growth' = 'growth') {
      const { tenant, headers } = await workspace(plan);
      const person = await h.member(world, await world.createTenant());
      const created = await invite(headers, {
        email: person.email,
        roleId: tenant.roles.operations,
      });
      const token = (await h.lastMail(person.email, 'staff.invite')).token as string;
      const personHeaders = await h.sessionHeaders(t, person.email);
      return {
        tenant,
        headers,
        person,
        personHeaders,
        token,
        invitationId: created.body.id as string,
      };
    }
    const acceptAs = (headers: Record<string, string>, token: string) =>
      t.http().post('/v1/me/invitations/accept').set(headers).send({ token });

    it('adds the membership to the logged-in account; they can then switch to the new workspace', async () => {
      const { tenant, person, personHeaders, token } = await invited();
      const res = await acceptAs(personHeaders, token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: tenant.id });

      const tenants = await t.http().get('/v1/me/tenants').set(personHeaders);
      expect(tenants.body.data.map((x: { id: string }) => x.id)).toContain(tenant.id);
      const switched = await t
        .http()
        .post('/v1/me/switch-tenant')
        .set(personHeaders)
        .send({ tenantId: tenant.id });
      expect(switched.status).toBe(200);
      expect(switched.body.access.roleName).toBe('Operations');
      expect(await world.auditRows(tenant, { action: 'staff.invite.accept' })).toHaveLength(1);
      expect(person.userId).toBeDefined();
    });

    it("someone else's invitation answers like an invalid one (400); the owner of the address can still use it", async () => {
      const { personHeaders, token, tenant } = await invited();
      const stranger = await h.member(world, await world.createTenant());
      const strangerHeaders = await h.sessionHeaders(t, stranger.email);
      const res = await acceptAs(strangerHeaders, token);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect((await acceptAs(personHeaders, token)).status).toBe(200);
      const members = await world.db.tx({ tenantId: tenant.id }, (tx) =>
        tx.membership.count({ where: { tenantId: tenant.id } }),
      );
      expect(members).toBe(2); // owner + the invited person
    });

    it('an unverified account cannot accept (403)', async () => {
      const { person, personHeaders, token } = await invited();
      await h.sql(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [person.userId]);
      expect((await acceptAs(personHeaders, token)).status).toBe(403);
    });

    it('someone who is already an active member gets 409; a deactivated one is re-activated with the new role', async () => {
      const { tenant, person, personHeaders, token } = await invited();
      expect((await acceptAs(personHeaders, token)).status).toBe(200);

      const again = await invite(
        await h.sessionHeaders(
          t,
          (
            await h.sql<{ email: string }>(
              `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role_id = $2`,
              [tenant.id, tenant.roles.owner],
            )
          )[0]!.email,
        ),
        { email: person.email, roleId: tenant.roles.sales_agent },
      );
      expect(again.status).toBe(409); // already an active member: cannot even be invited again

      await h.sql(`UPDATE memberships SET active = false WHERE tenant_id = $1 AND user_id = $2`, [
        tenant.id,
        person.userId,
      ]);
      const ownerEmail = (
        await h.sql<{ email: string }>(
          `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role_id = $2`,
          [tenant.id, tenant.roles.owner],
        )
      )[0]!.email;
      const reinvite = await invite(await h.sessionHeaders(t, ownerEmail), {
        email: person.email,
        roleId: tenant.roles.sales_agent,
      });
      expect(reinvite.status).toBe(201);
      const nextToken = (await h.lastMail(person.email, 'staff.invite')).token as string;
      expect((await acceptAs(personHeaders, nextToken)).status).toBe(200);
      const membership = await h.sql<{ active: boolean; role_id: string }>(
        `SELECT active, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.id, person.userId],
      );
      expect(membership).toEqual([{ active: true, role_id: tenant.roles.sales_agent }]);
    });

    it('needs a login (401), a valid body (400) and the CSRF headers (403)', async () => {
      const { personHeaders, token } = await invited();
      expect(
        (await t.http().post('/v1/me/invitations/accept').set(t.csrfHeaders).send({ token }))
          .status,
      ).toBe(401);
      expect((await acceptAs(personHeaders, 'short')).status).toBe(400);
      expect(
        (
          await t
            .http()
            .post('/v1/me/invitations/accept')
            .set({ Cookie: personHeaders.Cookie as string })
            .send({ token })
        ).status,
      ).toBe(403);
    });
  });
});
