import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '@venueos/shared';
import { hashToken } from '../modules/auth/auth.constants';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import {
  AuthHarness,
  TEST_ENV,
  TEST_PASSWORD,
  freshIp,
  signupBody,
  uniqueEmail,
} from './helpers/auth-harness';
import { World } from './helpers/world';

// POST /v1/auth/signup, verify-email, resend-verification (docs/04-security.md section 1, docs/09 P0-4).

describe('signup and email verification', () => {
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

  const signup = (body: Record<string, unknown>, ip = freshIp()) =>
    t.http().post('/v1/auth/signup').set(t.csrfHeaders).set('X-Forwarded-For', ip).send(body);

  describe('POST /v1/auth/signup', () => {
    it('answers 202 and creates user, tenant, five roles, owner membership, trial subscription and audit row', async () => {
      const body = signupBody({ tenantName: 'Grand Banquet' });
      const res = await signup(body);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        message: 'If this address can be used, we have sent you an email.',
      });

      const user = await h.authDb.client.user.findUniqueOrThrow({
        where: { email: body.email },
        include: { credentials: true },
      });
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.credentials?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
      expect(user.credentials?.passwordHash).not.toContain(TEST_PASSWORD);

      const mail = await h.lastMail(body.email, 'auth.verify-email');
      const tenant = await world.db.tx(
        { tenantId: mail.tenantId, userId: user.id },
        async (tx) => ({
          tenant: await tx.tenant.findUniqueOrThrow({ where: { id: mail.tenantId } }),
          roles: await tx.role.findMany({
            where: { tenantId: mail.tenantId },
            orderBy: { name: 'asc' },
          }),
          memberships: await tx.membership.findMany({
            where: { tenantId: mail.tenantId },
            include: { role: true },
          }),
          subscription: await tx.subscription.findFirstOrThrow({
            where: { tenantId: mail.tenantId },
            include: { plan: true },
          }),
          audit: await tx.auditLog.findMany({ where: { tenantId: mail.tenantId } }),
        }),
      );
      expect(tenant.tenant).toMatchObject({
        name: 'Grand Banquet',
        status: 'TRIAL',
        country: 'PK',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
      });
      expect(tenant.tenant.slug).toMatch(/^grand-banquet-[0-9a-f]{6}$/);
      const trialDays = (tenant.tenant.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
      expect(trialDays).toBeGreaterThan(13.9);
      expect(trialDays).toBeLessThan(14.1);
      expect(tenant.roles.map((r) => r.name).sort()).toEqual(
        DEFAULT_ROLES.map((r) => r.name).sort(),
      );
      expect(tenant.roles.every((r) => r.isSystem)).toBe(true);
      expect(tenant.memberships).toHaveLength(1);
      expect(tenant.memberships[0]).toMatchObject({ userId: user.id, active: true, venueIds: [] });
      expect(tenant.memberships[0]?.role.name).toBe('Owner');
      expect(tenant.subscription.plan.code).toBe('starter');
      expect(tenant.audit.map((a) => [a.action, a.actorType, a.actorUserId])).toEqual([
        ['tenant.signup', 'USER', user.id],
      ]);
    });

    it('queues the verification mail in the same transaction; the link is sealed, never stored in plain text', async () => {
      const body = signupBody({ defaultLocale: 'ar' });
      await signup(body);
      const mail = await h.lastMail(body.email, 'auth.verify-email');
      expect(mail.locale).toBe('ar'); // the chosen language is kept on the message; the template falls back to English
      expect(mail.event).toBe('auth.verify_email');
      expect(mail.vars).toMatchObject({ name: 'Ali Khan', hours: 24 });
      expect(String(mail.vars.verifyUrl)).toMatch(
        /^http:\/\/localhost:3000\/verify-email\?token=[\w-]{43}$/,
      );
      expect(mail.token).toMatch(/^[\w-]{43}$/);
      // Not in the stored row, not in the job, only its hash is in the database.
      expect(JSON.stringify(mail.storedVars)).not.toContain(mail.token as string);
      const jobs = await h.sql<{ data: unknown }>(
        `SELECT data FROM pgboss.job WHERE data->>'messageKey' = $1`,
        [mail.messageKey],
      );
      expect(jobs).toHaveLength(1);
      expect(JSON.stringify(jobs[0]?.data)).not.toContain(mail.token as string);
      expect(
        await h.count('auth_tokens', 'token_hash = $1', [hashToken(mail.token as string)]),
      ).toBe(1);
      expect(await h.count('auth_tokens', `token_hash = $1`, [mail.token])).toBe(0);
    });

    it('is enumeration-safe: an existing address gets the exact same answer, no second tenant, and an "account exists" mail', async () => {
      const body = signupBody();
      const first = await signup(body);
      await h.authDb.client.user.update({
        where: { email: body.email },
        data: { emailVerifiedAt: new Date() },
      });
      const tenantsBefore = (await h.mails(body.email)).length;

      const again = await signup({ ...body, tenantName: 'Another Name', name: 'Someone Else' });
      expect(again.status).toBe(first.status);
      expect(again.body).toEqual(first.body);
      expect(Object.keys(again.headers).filter((k) => k.startsWith('set-cookie'))).toEqual([]);

      // The account was not touched and no second workspace exists.
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(user.name).toBe('Ali Khan');
      const memberships = await world.db.asUser(user.id, (tx) =>
        tx.membership.count({ where: { userId: user.id } }),
      );
      expect(memberships).toBe(1);
      const mails = await h.mails(body.email);
      expect(mails.length).toBe(tenantsBefore + 1);
      const notice = await h.lastMail(body.email, 'auth.account-exists');
      expect(notice.vars).toMatchObject({
        loginUrl: 'http://localhost:3000/login',
        forgotUrl: 'http://localhost:3000/forgot-password',
      });
      expect(notice.token).toBeUndefined();
    });

    it('an unverified address signing up again: the latest signup wins (new password, fresh token), still one workspace', async () => {
      const body = signupBody();
      await signup(body);
      const oldToken = (await h.lastMail(body.email, 'auth.verify-email')).token as string;
      const second = await signup({
        ...body,
        password: 'a different long password 77',
        name: 'Ali Again',
      });
      expect(second.status).toBe(202);

      const newToken = (await h.mails(body.email, 'auth.verify-email')).at(-1)?.token as string;
      expect(newToken).not.toBe(oldToken);
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(user.name).toBe('Ali Again');
      expect(
        await world.db.asUser(user.id, (tx) => tx.membership.count({ where: { userId: user.id } })),
      ).toBe(1);

      // The first link is dead, the second works, and only the NEW password logs in.
      const dead = await t
        .http()
        .post('/v1/auth/verify-email')
        .set(t.csrfHeaders)
        .send({ token: oldToken });
      expect(dead.status).toBe(400);
      const ok = await t
        .http()
        .post('/v1/auth/verify-email')
        .set(t.csrfHeaders)
        .send({ token: newToken });
      expect(ok.status).toBe(204);
      expect((await h.login(t, body.email, TEST_PASSWORD)).status).toBe(401);
      expect((await h.login(t, body.email, 'a different long password 77')).status).toBe(200);
    });

    it('an abandoned signup whose credentials auth.purge removed can sign up again: same user, same workspace, new password', async () => {
      const body = signupBody();
      await signup(body);
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      // What the worker's auth.purge leaves of an unverified signup after 30 days: the user row and its
      // workspace stay, the password hash and the tokens are gone (apps/worker auth-purge.job.ts).
      await h.authDb.tx(async (tx) => {
        await tx.authToken.deleteMany({ where: { userId: user.id } });
        await tx.userCredential.deleteMany({ where: { userId: user.id } });
      });
      expect((await h.login(t, body.email, TEST_PASSWORD)).status).toBe(401);

      expect((await signup({ ...body, password: 'a fresh long password 91' })).status).toBe(202);
      const token = (await h.mails(body.email, 'auth.verify-email')).at(-1)?.token as string;
      const verified = await t
        .http()
        .post('/v1/auth/verify-email')
        .set(t.csrfHeaders)
        .send({ token });
      expect(verified.status).toBe(204);
      expect((await h.login(t, body.email, 'a fresh long password 91')).status).toBe(200);
      const again = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(again.id).toBe(user.id);
      expect(
        await world.db.asUser(user.id, (tx) => tx.membership.count({ where: { userId: user.id } })),
      ).toBe(1);
    });

    it('rejects invalid input with 400 VALIDATION_ERROR and creates nothing', async () => {
      const cases: Record<string, unknown>[] = [
        { email: 'not-an-email' },
        { password: 'short' },
        { password: 'x'.repeat(129) },
        { tenantName: 'x' },
        { country: 'pk' },
        { currency: 'XXX' },
        { timezone: 'Mars/Phobos' },
        { defaultLocale: 'English' },
        { name: '' },
      ];
      for (const override of cases) {
        const body = signupBody(override);
        const res = await signup(body);
        expect(res.status, JSON.stringify(override)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(await h.authDb.client.user.count({ where: { email: body.email } })).toBe(0);
      }
    });

    it('rejects a breached password (top 10,000 list) with 400 on the password field', async () => {
      const res = await signup(signupBody({ password: 'qwertyuiop' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([
        {
          path: 'password',
          code: 'custom',
          message: 'This password is too common. Choose another one.',
        },
      ]);
    });

    it('normalizes the address (case, spaces) so it cannot be registered twice', async () => {
      const body = signupBody();
      await signup({ ...body, email: `  ${body.email.toUpperCase()} ` });
      expect(await h.authDb.client.user.count({ where: { email: body.email } })).toBe(1);
    });

    it('is refused without the CSRF header or with a foreign Origin (403 CSRF_REJECTED)', async () => {
      const body = signupBody();
      const noHeader = await t
        .http()
        .post('/v1/auth/signup')
        .set('Origin', 'http://localhost:3000')
        .send(body);
      expect(noHeader.status).toBe(403);
      expect(noHeader.body.error.code).toBe('CSRF_REJECTED');
      const foreign = await t
        .http()
        .post('/v1/auth/signup')
        .set({ 'X-Requested-With': 'venueos', Origin: 'https://evil.example' })
        .send(body);
      expect(foreign.status).toBe(403);
      expect(await h.authDb.client.user.count({ where: { email: body.email } })).toBe(0);
    });

    it('logs no password and no address', async () => {
      const body = signupBody();
      await signup(body);
      expect(t.rawLogs()).not.toContain(TEST_PASSWORD);
      expect(t.rawLogs()).not.toContain(body.email);
    });
  });

  describe('abuse limits (answered generically, nothing sent)', () => {
    it('allows 3 mails per address per hour; the 4th request is answered the same and sends nothing', async () => {
      const body = signupBody();
      const ip = freshIp();
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await signup(body, `${ip}`));
      expect(answers.map((r) => r.status)).toEqual([202, 202, 202, 202]);
      expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
      // 1st creates the account, 2nd and 3rd re-send verification, the 4th is refused.
      expect((await h.mails(body.email, 'auth.verify-email')).length).toBe(3);
      const rows = await h.sql<{ kind: string }>(
        `SELECT kind FROM auth_requests WHERE email_hash = $1 ORDER BY created_at, id`,
        [h.emailHash(body.email)],
      );
      expect(rows.map((r) => r.kind)).toEqual(['signup', 'signup', 'signup', 'limited']);
      expect(
        t
          .logLines()
          .some(
            (l) =>
              l.msg === 'Auth mail request over the limit: answered generically, nothing sent' &&
              l.reason === 'email',
          ),
      ).toBe(true);
      expect(t.rawLogs()).not.toContain(body.email);
    });

    it('allows 20 requests per IP per 15 minutes; the 21st sends nothing, whatever the address', async () => {
      const ip = freshIp();
      const emails: string[] = [];
      for (let i = 0; i < 21; i++) {
        const email = uniqueEmail('ip');
        emails.push(email);
        expect((await signup(signupBody({ email }), ip)).status).toBe(202);
      }
      expect(
        await h.authDb.client.user.count({ where: { email: { in: emails.slice(0, 20) } } }),
      ).toBe(20);
      expect(await h.authDb.client.user.count({ where: { email: emails[20] } })).toBe(0);
      expect(t.logLines().some((l) => l.kind === 'signup' && l.reason === 'ip')).toBe(true);
    }, 90_000);

    it('stores only a hash of the address, never the address', async () => {
      const body = signupBody();
      await signup(body);
      const dump = JSON.stringify(
        await h.sql(`SELECT * FROM auth_requests WHERE email_hash = $1`, [h.emailHash(body.email)]),
      );
      expect(dump).not.toContain(body.email);
    });
  });

  describe('POST /v1/auth/verify-email', () => {
    it('confirms the address with the token from the mail (204), once', async () => {
      const body = signupBody();
      await signup(body);
      const { token } = await h.lastMail(body.email, 'auth.verify-email');

      const res = await t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token });
      expect(res.status).toBe(204);
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(user.emailVerifiedAt).not.toBeNull();

      const reuse = await t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token });
      expect(reuse.status).toBe(400);
      expect(reuse.body.error.code).toBe('BAD_REQUEST');
    });

    it('refuses an unknown, malformed, expired or wrong-purpose token with the same 400', async () => {
      const body = signupBody();
      await signup(body);
      const { token } = await h.lastMail(body.email, 'auth.verify-email');
      await h.sql(
        `UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [body.email],
      );

      const answers = await Promise.all(
        [token, 'A'.repeat(43), 'short'].map((value) =>
          t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token: value }),
        ),
      );
      expect(answers[0]?.status).toBe(400);
      expect(answers[1]?.status).toBe(400);
      expect(answers[0]?.body.error.message).toBe(answers[1]?.body.error.message);
      expect(answers[2]?.body.error.code).toBe('VALIDATION_ERROR');
      const user = await h.authDb.client.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('is refused without the CSRF header (403)', async () => {
      const res = await t
        .http()
        .post('/v1/auth/verify-email')
        .send({ token: 'A'.repeat(43) });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /v1/auth/resend-verification', () => {
    it('sends a new link and invalidates the old one', async () => {
      const body = signupBody();
      await signup(body);
      const first = (await h.lastMail(body.email, 'auth.verify-email')).token as string;

      const res = await t
        .http()
        .post('/v1/auth/resend-verification')
        .set(t.csrfHeaders)
        .set('X-Forwarded-For', freshIp())
        .send({ email: body.email });
      expect(res.status).toBe(202);
      const second = (await h.lastMail(body.email, 'auth.verify-email')).token as string;
      expect(second).not.toBe(first);
      expect(
        (await t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token: first }))
          .status,
      ).toBe(400);
      expect(
        (await t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token: second }))
          .status,
      ).toBe(204);
    });

    it('answers identically for an unknown or an already verified address, and sends nothing', async () => {
      const verified = signupBody();
      await signup(verified);
      const { token } = await h.lastMail(verified.email, 'auth.verify-email');
      await t.http().post('/v1/auth/verify-email').set(t.csrfHeaders).send({ token });
      const before = (await h.mails(verified.email)).length;

      const known = await t
        .http()
        .post('/v1/auth/resend-verification')
        .set(t.csrfHeaders)
        .set('X-Forwarded-For', freshIp())
        .send({ email: verified.email });
      const unknown = await t
        .http()
        .post('/v1/auth/resend-verification')
        .set(t.csrfHeaders)
        .set('X-Forwarded-For', freshIp())
        .send({ email: uniqueEmail('ghost') });
      expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
      expect(known.status).toBe(202);
      expect((await h.mails(verified.email)).length).toBe(before);
    });

    it('validates the body (400) and the CSRF header (403), and is limited like signup', async () => {
      expect(
        (
          await t
            .http()
            .post('/v1/auth/resend-verification')
            .set(t.csrfHeaders)
            .send({ email: 'nope' })
        ).status,
      ).toBe(400);
      expect(
        (await t.http().post('/v1/auth/resend-verification').send({ email: 'a@b.test' })).status,
      ).toBe(403);

      const body = signupBody();
      const ip = freshIp();
      await signup(body, ip); // 1st mail of the hour
      for (let i = 0; i < 4; i++) {
        await t
          .http()
          .post('/v1/auth/resend-verification')
          .set(t.csrfHeaders)
          .set('X-Forwarded-For', ip)
          .send({ email: body.email });
      }
      expect((await h.mails(body.email, 'auth.verify-email')).length).toBe(3);
    });
  });
});
