import { argon2Sync, randomBytes } from 'node:crypto';
import { EMAIL_NOT_VERIFIED_REASON } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../modules/auth/auth.constants';
import { PasswordService } from '../modules/auth/password.service';
import {
  AuthHarness,
  SESSION_COOKIE,
  TEST_ENV,
  TEST_PASSWORD,
  freshIp,
  uniqueEmail,
} from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// POST /v1/auth/login (docs/04-security.md section 1): sessions, argon2id, lockout, IP limit, generic answers.

describe('login', () => {
  let t: TestApp;
  let h: AuthHarness;
  let world: World;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await createTestApp({ env: TEST_ENV, realAuth: true });
    h = new AuthHarness();
    world = new World();
    tenant = await world.createTenant();
  });
  afterAll(async () => {
    await t.app.close();
    await h.close();
    await world.close();
  });

  const post = (body: Record<string, unknown>, ip = freshIp()) =>
    t.http().post('/v1/auth/login').set(t.csrfHeaders).set('X-Forwarded-For', ip).send(body);

  describe('success', () => {
    it('returns the user and the workspace and sets the __Host- session cookie with the required flags', async () => {
      const member = await h.member(world, tenant, { role: 'owner' });
      const res = await post({ email: member.email, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({
        id: member.userId,
        name: 'Test User',
        email: member.email,
        emailVerified: true,
      });
      expect(res.body.activeTenantId).toBe(tenant.id); // the only workspace: chosen for the user
      expect(res.body.tenants.map((x: { id: string }) => x.id)).toEqual([tenant.id]);

      const line = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(`${SESSION_COOKIE}=`),
      ) as string;
      expect(line).toMatch(/^__Host-vos_session=[\w-]{43};/);
      expect(line).toContain('HttpOnly');
      expect(line).toContain('Secure');
      expect(line).toContain('SameSite=Lax');
      expect(line).toContain('Path=/');
      expect(line.toLowerCase()).not.toContain('domain=');
      expect(JSON.stringify(res.body)).not.toContain(hashToken(h.tokenOfCookie(h.cookieOf(res))));
    });

    it('stores only the SHA-256 hash of the 32-byte token; 30 days absolute lifetime', async () => {
      const member = await h.member(world, tenant);
      const res = await post({ email: member.email, password: TEST_PASSWORD });
      const cookie = h.cookieOf(res);
      const token = h.tokenOfCookie(cookie);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);

      const row = await h.sessionRow(cookie);
      expect(row?.tokenHash).toBe(hashToken(token));
      expect(row?.tokenHash).not.toContain(token);
      expect(row?.userId).toBe(member.userId);
      const days = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      expect(
        await h.count('auth_sessions', 'user_id = $1 AND token_hash = $2', [member.userId, token]),
      ).toBe(0);
    });

    it('is case-insensitive on the address', async () => {
      const member = await h.member(world, tenant);
      expect(
        (await post({ email: ` ${member.email.toUpperCase()}`, password: TEST_PASSWORD })).status,
      ).toBe(200);
    });

    it('chooses no workspace when the user has several (they pick one), and none when they have none', async () => {
      const second = await world.createTenant();
      const two = await h.member(world, tenant);
      await world.addMember(second, { userId: two.userId });
      const res = await post({ email: two.email, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.activeTenantId).toBeNull();
      expect(res.body.tenants).toHaveLength(2);

      const lone = await world.createUser();
      await h.giveCredentials(lone);
      const none = await post({ email: await h.emailOf(lone), password: TEST_PASSWORD });
      expect(none.status).toBe(200);
      expect(none.body).toMatchObject({ activeTenantId: null, tenants: [] });
    });

    it('every login creates a NEW session and kills the one it was called with (no fixation)', async () => {
      const member = await h.member(world, tenant);
      const first = h.cookieOf(await post({ email: member.email, password: TEST_PASSWORD }));
      const again = await t
        .http()
        .post('/v1/auth/login')
        .set(t.csrfHeaders)
        .set('X-Forwarded-For', freshIp())
        .set('Cookie', first)
        .send({ email: member.email, password: TEST_PASSWORD });
      const second = h.cookieOf(again);
      expect(second).not.toBe(first);
      expect((await h.sessionRow(first))?.revokedAt).not.toBeNull();
      expect((await h.sessionRow(second))?.revokedAt).toBeNull();
      expect((await t.http().get('/v1/me').set('Cookie', first)).status).toBe(401);
      expect((await t.http().get('/v1/me').set('Cookie', second)).status).toBe(200);
    });

    it('rehashes a stored hash that uses weaker parameters, and still logs in', async () => {
      const member = await world.addMember(tenant);
      const salt = randomBytes(16);
      const tag = argon2Sync('argon2id', {
        message: TEST_PASSWORD,
        nonce: salt,
        parallelism: 1,
        tagLength: 32,
        memory: 19_456,
        passes: 2,
      });
      const weak = `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`;
      await h.giveCredentials(member.userId, weak);

      expect(
        (await post({ email: await h.emailOf(member.userId), password: TEST_PASSWORD })).status,
      ).toBe(200);
      const stored = (
        await h.authDb.client.userCredential.findUniqueOrThrow({ where: { userId: member.userId } })
      ).passwordHash;
      expect(stored).not.toBe(weak);
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
      expect(
        (await post({ email: await h.emailOf(member.userId), password: TEST_PASSWORD })).status,
      ).toBe(200);
    });

    it('verifies a hash written exactly like the seed does (PHC string, same parameters)', async () => {
      const service = new PasswordService();
      const salt = randomBytes(16);
      const tag = argon2Sync('argon2id', {
        message: 'seed-style-password',
        nonce: salt,
        parallelism: 4,
        tagLength: 32,
        memory: 65_536,
        passes: 3,
      });
      const phc = `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`;
      expect(await service.verify('seed-style-password', phc)).toBe(true);
      expect(await service.verify('another password', phc)).toBe(false);
      expect(service.needsRehash(phc)).toBe(false);
    });
  });

  describe('refusals', () => {
    it('unknown address, wrong password: the same 401 (same message), and a real hash check runs both times', async () => {
      const member = await h.member(world, tenant);
      const service = t.app.get(PasswordService, { strict: false });
      const dummy = vi.spyOn(service, 'verifyDummy');
      const verify = vi.spyOn(service, 'verify');

      const wrong = await post({ email: member.email, password: 'wrong password entirely' });
      const unknown = await post({
        email: uniqueEmail('ghost'),
        password: 'wrong password entirely',
      });
      expect([wrong.status, wrong.body.error.code, wrong.body.error.message]).toEqual([
        unknown.status,
        unknown.body.error.code,
        unknown.body.error.message,
      ]);
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
      expect(wrong.body.error.message).toBe('Invalid email or password.');
      expect(verify).toHaveBeenCalledTimes(2); // the real account, plus the dummy check inside verifyDummy
      expect(dummy).toHaveBeenCalledTimes(1); // the unknown one costs the same
      expect(wrong.headers['set-cookie']).toBeUndefined();
      vi.restoreAllMocks();
    });

    it('a correct password for an unverified address: 403 with a reason, only after the password was right', async () => {
      const user = await world.createUser();
      await h.giveCredentials(user);
      const email = await h.emailOf(user);
      await h.sql(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [user]);

      const wrong = await post({ email, password: 'not the password at all' });
      expect(wrong.status).toBe(401);
      const right = await post({ email, password: TEST_PASSWORD });
      expect(right.status).toBe(403);
      expect(right.body.error.code).toBe('FORBIDDEN');
      expect(right.body.error.details).toEqual({ reason: EMAIL_NOT_VERIFIED_REASON });
      expect(right.headers['set-cookie']).toBeUndefined();
    });

    it('locks the account after 5 failures in 15 minutes: even the right password then answers 401', async () => {
      const member = await h.member(world, tenant);
      for (let i = 0; i < 5; i++) {
        expect((await post({ email: member.email, password: `wrong password ${i}` })).status).toBe(
          401,
        );
      }
      const credentials = await h.authDb.client.userCredential.findUniqueOrThrow({
        where: { userId: member.userId },
      });
      expect(credentials.failedLoginCount).toBe(5);
      expect(credentials.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

      const locked = await post({ email: member.email, password: TEST_PASSWORD });
      expect(locked.status).toBe(401);
      expect(locked.body.error.message).toBe('Invalid email or password.');
      expect(locked.headers['set-cookie']).toBeUndefined();

      // 15 minutes later it works again, and the failure counter starts over.
      await h.sql(
        `UPDATE login_attempts SET created_at = now() - interval '16 minutes' WHERE email_hash = $1`,
        [h.emailHash(member.email)],
      );
      await h.sql(
        `UPDATE user_credentials SET locked_until = now() - interval '1 minute' WHERE user_id = $1`,
        [member.userId],
      );
      expect((await post({ email: member.email, password: TEST_PASSWORD })).status).toBe(200);
      const after = await h.authDb.client.userCredential.findUniqueOrThrow({
        where: { userId: member.userId },
      });
      expect([after.failedLoginCount, after.lockedUntil]).toEqual([0, null]);
    });

    it('counts failures per address even when the address does not exist (no oracle, no lock bypass)', async () => {
      const email = uniqueEmail('nobody');
      for (let i = 0; i < 6; i++) await post({ email, password: 'whatever it is 1234' });
      expect(
        await h.count('login_attempts', 'email_hash = $1 AND NOT succeeded', [h.emailHash(email)]),
      ).toBe(6);
      expect(
        await h.count('login_attempts', 'email_hash = $1 AND ip IS NOT NULL', [h.emailHash(email)]),
      ).toBe(6);
    });

    it('answers 429 RATE_LIMITED after 20 attempts from one IP in 15 minutes, whatever the address', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        expect(
          (await post({ email: uniqueEmail('spray'), password: 'whatever it is 1234' }, ip)).status,
        ).toBe(401);
      }
      const member = await h.member(world, tenant);
      const blocked = await post({ email: member.email, password: TEST_PASSWORD }, ip);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBe('900');
      expect(blocked.headers['set-cookie']).toBeUndefined();
      // Another address elsewhere is unaffected.
      expect((await post({ email: member.email, password: TEST_PASSWORD })).status).toBe(200);
      // 21 real password hashes: slower than the 20 s default when the whole suite runs in parallel.
    }, 90_000);

    it('validates the body (400) and the CSRF headers (403)', async () => {
      expect((await post({ email: 'nope', password: 'x' })).status).toBe(400);
      expect((await post({ email: 'a@b.test' })).status).toBe(400);
      expect((await post({ email: 'a@b.test', password: '' })).status).toBe(400);
      const noCsrf = await t
        .http()
        .post('/v1/auth/login')
        .send({ email: 'a@b.test', password: 'x' });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
    });

    it('never logs the password, the address or the session token', async () => {
      const member = await h.member(world, tenant);
      const res = await post({ email: member.email, password: TEST_PASSWORD });
      await post({ email: member.email, password: 'a wrong password 99' });
      const logs = t.rawLogs();
      expect(logs).not.toContain(TEST_PASSWORD);
      expect(logs).not.toContain('a wrong password 99');
      expect(logs).not.toContain(member.email);
      expect(logs).not.toContain(h.tokenOfCookie(h.cookieOf(res)));
    });
  });
});
