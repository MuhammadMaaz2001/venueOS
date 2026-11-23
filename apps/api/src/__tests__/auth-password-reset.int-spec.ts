import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../modules/auth/auth.constants';
import { AuthHarness, TEST_ENV, TEST_PASSWORD, freshIp, uniqueEmail } from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// POST /v1/auth/password/forgot and /reset (docs/04-security.md section 1).

describe('password reset', () => {
  let t: TestApp;
  let h: AuthHarness;
  let world: World;
  let tenant: TestTenant;
  const NEW_PASSWORD = 'a brand new passphrase 2027';

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

  const forgot = (email: string, ip = freshIp()) =>
    t
      .http()
      .post('/v1/auth/password/forgot')
      .set(t.csrfHeaders)
      .set('X-Forwarded-For', ip)
      .send({ email });
  const reset = (body: Record<string, unknown>) =>
    t.http().post('/v1/auth/password/reset').set(t.csrfHeaders).send(body);

  describe('POST /v1/auth/password/forgot', () => {
    it('queues the reset mail (sealed link, 30 minute token) under the product name and answers 202', async () => {
      const member = await h.member(world, tenant);
      const res = await forgot(member.email);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        message: 'If this address can be used, we have sent you an email.',
      });

      const mail = await h.lastMail(member.email, 'auth.password-reset');
      expect(mail.tenantId).toBe(tenant.id); // the user's oldest workspace owns the log row
      expect(mail.vars).toMatchObject({ name: 'Test User', minutes: 30 });
      expect(String(mail.vars.resetUrl)).toMatch(
        /^http:\/\/localhost:3000\/reset-password\?token=[\w-]{43}$/,
      );
      expect(JSON.stringify(mail.storedVars)).not.toContain(mail.token as string);

      const row = await h.authDb.client.authToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(mail.token as string) },
      });
      expect(row.purpose).toBe('PASSWORD_RESET');
      const minutes = (row.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThan(30.5);
    });

    it('is enumeration-safe: an unknown address gets the same answer and nothing is sent', async () => {
      const member = await h.member(world, tenant);
      const known = await forgot(member.email);
      const ghost = uniqueEmail('ghost');
      const unknown = await forgot(ghost);
      expect([unknown.status, unknown.body]).toEqual([known.status, known.body]);
      expect(await h.mails(ghost)).toEqual([]);
      expect(
        await h.count('auth_tokens', `user_id IN (SELECT id FROM users WHERE email = $1)`, [ghost]),
      ).toBe(0);
    });

    it('a user without any workspace gets the same answer and no mail (the log is tenant-scoped)', async () => {
      const lone = await world.createUser();
      await h.giveCredentials(lone);
      const email = await h.emailOf(lone);
      expect((await forgot(email)).status).toBe(202);
      expect(await h.mails(email)).toEqual([]);
    });

    it('a new request invalidates the earlier link', async () => {
      const member = await h.member(world, tenant);
      await forgot(member.email);
      const first = (await h.lastMail(member.email, 'auth.password-reset')).token as string;
      await forgot(member.email);
      const second = (await h.lastMail(member.email, 'auth.password-reset')).token as string;
      expect(second).not.toBe(first);
      expect((await reset({ token: first, newPassword: NEW_PASSWORD })).status).toBe(400);
      expect((await reset({ token: second, newPassword: NEW_PASSWORD })).status).toBe(204);
    });

    it('allows 3 mails per address per hour; the 4th is answered the same and sends nothing', async () => {
      const member = await h.member(world, tenant);
      const ip = freshIp();
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await forgot(member.email, ip));
      expect(new Set(answers.map((a) => `${a.status}${JSON.stringify(a.body)}`)).size).toBe(1);
      expect((await h.mails(member.email, 'auth.password-reset')).length).toBe(3);
    });

    it('allows 20 requests per IP per 15 minutes; later ones send nothing', async () => {
      const ip = freshIp();
      const members = [];
      for (let i = 0; i < 21; i++) members.push(await h.member(world, tenant));
      for (const m of members) expect((await forgot(m.email, ip)).status).toBe(202);
      expect((await h.mails(members[19]!.email, 'auth.password-reset')).length).toBe(1);
      expect(await h.mails(members[20]!.email, 'auth.password-reset')).toEqual([]);
    }, 90_000);

    it('validates the body (400) and the CSRF headers (403)', async () => {
      expect(
        (await t.http().post('/v1/auth/password/forgot').set(t.csrfHeaders).send({ email: 'nope' }))
          .status,
      ).toBe(400);
      expect(
        (await t.http().post('/v1/auth/password/forgot').send({ email: 'a@b.test' })).status,
      ).toBe(403);
    });
  });

  describe('POST /v1/auth/password/reset', () => {
    async function requestToken(email: string): Promise<string> {
      await forgot(email);
      return (await h.lastMail(email, 'auth.password-reset')).token as string;
    }

    it('sets the new password (204), once; the old password stops working', async () => {
      const member = await h.member(world, tenant);
      const token = await requestToken(member.email);
      expect((await reset({ token, newPassword: NEW_PASSWORD })).status).toBe(204);

      expect((await h.login(t, member.email, TEST_PASSWORD)).status).toBe(401);
      expect((await h.login(t, member.email, NEW_PASSWORD)).status).toBe(200);
      const reuse = await reset({ token, newPassword: 'yet another passphrase 33' });
      expect(reuse.status).toBe(400);
      expect(reuse.body.error.code).toBe('BAD_REQUEST');
      expect((await h.login(t, member.email, NEW_PASSWORD)).status).toBe(200);
    });

    it('revokes EVERY session of the user, and only theirs', async () => {
      const member = await h.member(world, tenant);
      const bystander = await h.member(world, tenant);
      const a = h.cookieOf(await h.login(t, member.email));
      const b = h.cookieOf(await h.login(t, member.email));
      const other = h.cookieOf(await h.login(t, bystander.email));

      await reset({ token: await requestToken(member.email), newPassword: NEW_PASSWORD });
      expect((await t.http().get('/v1/me').set('Cookie', a)).status).toBe(401);
      expect((await t.http().get('/v1/me').set('Cookie', b)).status).toBe(401);
      expect((await t.http().get('/v1/me').set('Cookie', other)).status).toBe(200);
    });

    it('clears a lockout, and confirms the address of an unverified user (the mail reached them)', async () => {
      const member = await h.member(world, tenant);
      for (let i = 0; i < 5; i++) await h.login(t, member.email, `wrong ${i} wrong ${i}`);
      expect((await h.login(t, member.email)).status).toBe(401); // locked
      await h.sql(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [member.userId]);

      await reset({ token: await requestToken(member.email), newPassword: NEW_PASSWORD });
      await h.sql(
        `UPDATE login_attempts SET created_at = now() - interval '16 minutes' WHERE email_hash = $1`,
        [h.emailHash(member.email)],
      );
      expect((await h.login(t, member.email, NEW_PASSWORD)).status).toBe(200);
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { id: member.userId } });
      expect(user.emailVerifiedAt).not.toBeNull();
    });

    it('refuses an unknown, expired, malformed or foreign-purpose token with the same 400', async () => {
      const member = await h.member(world, tenant);
      const token = await requestToken(member.email);
      await h.sql(
        `UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [hashToken(token)],
      );

      const expired = await reset({ token, newPassword: NEW_PASSWORD });
      const unknown = await reset({ token: 'B'.repeat(43), newPassword: NEW_PASSWORD });
      expect([expired.status, expired.body.error.message]).toEqual([
        unknown.status,
        unknown.body.error.message,
      ]);
      expect(expired.status).toBe(400);
      expect((await reset({ token: 'short', newPassword: NEW_PASSWORD })).status).toBe(400);

      // An email-verification token cannot reset a password.
      const verifyToken = 'V'.repeat(43);
      await h.authDb.client.authToken.create({
        data: {
          userId: member.userId,
          purpose: 'EMAIL_VERIFY',
          tokenHash: hashToken(verifyToken),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect((await reset({ token: verifyToken, newPassword: NEW_PASSWORD })).status).toBe(400);
      expect((await h.login(t, member.email)).status).toBe(200); // password unchanged
    });

    it('applies the password policy (400) without burning the token', async () => {
      const member = await h.member(world, tenant);
      const token = await requestToken(member.email);
      expect((await reset({ token, newPassword: 'short' })).status).toBe(400);
      const breached = await reset({ token, newPassword: 'qwertyuiop' });
      expect(breached.status).toBe(400);
      expect(breached.body.error.details[0].path).toBe('newPassword');
      expect((await reset({ token, newPassword: NEW_PASSWORD })).status).toBe(204);
    });

    it('is single-use even when two requests race', async () => {
      const member = await h.member(world, tenant);
      const token = await requestToken(member.email);
      const results = await Promise.all([
        reset({ token, newPassword: NEW_PASSWORD }),
        reset({ token, newPassword: 'the other racing passphrase 5' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    });

    it('needs the CSRF headers (403) and a body (400)', async () => {
      expect(
        (
          await t
            .http()
            .post('/v1/auth/password/reset')
            .send({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD })
        ).status,
      ).toBe(403);
      expect((await reset({})).status).toBe(400);
    });

    it('never logs the token, the password or the address', async () => {
      const member = await h.member(world, tenant);
      const token = await requestToken(member.email);
      await reset({ token, newPassword: NEW_PASSWORD });
      const logs = t.rawLogs();
      expect(logs).not.toContain(token);
      expect(logs).not.toContain(NEW_PASSWORD);
      expect(logs).not.toContain(member.email);
    });
  });
});
