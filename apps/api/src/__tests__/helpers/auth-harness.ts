import { randomInt } from 'node:crypto';
import { AuthDb, createSealer, openTemplateVars } from '@venueos/db';
import type { AuthSession } from '@venueos/db';
import pg from 'pg';
import type { Response } from 'supertest';
import { hashEmail, hashToken } from '../../modules/auth/auth.constants';
import { PasswordService } from '../../modules/auth/password.service';
import { TEST_KEYRING } from './create-test-app';
import type { TestApp } from './create-test-app';
import type { TestMember, TestTenant, World } from './world';

/** Not in the breached list, long enough. Every fixture user has it. */
export const TEST_PASSWORD = 'correct horse battery staple 42';

export const SESSION_COOKIE = '__Host-vos_session';

// Each test file gets its own address range: all files share one database, and the limits are per IP.
const ipBase = randomInt(1, 220);
let ipCounter = 0;
/** A client address nobody else in this test run uses (send it as X-Forwarded-For; the app trusts 1 proxy). */
export function freshIp(): string {
  const n = ipCounter++;
  return `10.${ipBase}.${(n >> 8) & 255}.${n & 255}`;
}

export const TEST_ENV = { TRUST_PROXY: '1' };

export interface ParsedMail {
  tenantId: string;
  messageKey: string;
  to: string;
  template: string;
  locale: string;
  event: string | null;
  /** Plain and sealed variables, opened with the test keyring. */
  vars: Record<string, unknown>;
  /** The `token` query parameter of whichever link the mail carries (verifyUrl, resetUrl, acceptUrl). */
  token: string | undefined;
  /** The raw stored `template_vars`, to prove a secret is never there in plain text. */
  storedVars: unknown;
}

/**
 * Helpers for tests that go through the real login flow: fixture users with a password, cookies, and the
 * emails the API queued (read as the database superuser, because `message_logs` is under row level security
 * and a signup's tenant is not known to the test; the secret links are opened with the test keyring).
 */
export class AuthHarness {
  readonly authDb = new AuthDb({ connectionString: process.env.AUTH_DATABASE_URL as string });
  private readonly sealer = createSealer(TEST_KEYRING);
  private readonly superuser = new pg.Pool({
    connectionString: process.env.VENUEOS_TEST_SUPERUSER_URL,
    max: 2,
  });
  private passwordHash: string | undefined;

  async close(): Promise<void> {
    await this.authDb.close();
    await this.superuser.end();
  }

  /** The hash of TEST_PASSWORD with the current parameters, computed once for the whole run. */
  private async hash(): Promise<string> {
    this.passwordHash ??= await new PasswordService().hash(TEST_PASSWORD);
    return this.passwordHash;
  }

  /** Give an existing fixture user (World.createUser/addMember) the test password. */
  async giveCredentials(userId: string, passwordHash?: string): Promise<void> {
    await this.authDb.client.userCredential.create({
      data: { userId, passwordHash: passwordHash ?? (await this.hash()) },
    });
  }

  async emailOf(userId: string): Promise<string> {
    const user = await this.authDb.client.user.findUniqueOrThrow({ where: { id: userId } });
    return user.email as string;
  }

  /** A member of `tenant` who can log in with TEST_PASSWORD. */
  async member(
    world: World,
    tenant: TestTenant,
    options: Parameters<World['addMember']>[1] = {},
  ): Promise<TestMember & { email: string }> {
    const member = await world.addMember(tenant, options);
    await this.giveCredentials(member.userId);
    return { ...member, email: await this.emailOf(member.userId) };
  }

  login(t: TestApp, email: string, password = TEST_PASSWORD, ip = freshIp()) {
    return t
      .http()
      .post('/v1/auth/login')
      .set(t.csrfHeaders)
      .set('X-Forwarded-For', ip)
      .send({ email, password });
  }

  /** `Cookie` header value of a login response. */
  cookieOf(res: Response): string {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = header?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!line) throw new Error('no session cookie in the response');
    return (line.split(';')[0] as string).trim();
  }

  /** Log a member in and return the headers that act as them (cookie + CSRF headers). */
  async sessionHeaders(t: TestApp, email: string): Promise<Record<string, string>> {
    const res = await this.login(t, email);
    if (res.status !== 200) throw new Error(`login failed in a test fixture: ${res.status}`);
    return { ...t.csrfHeaders, Cookie: this.cookieOf(res) };
  }

  /** Raw session token of a cookie string. */
  tokenOfCookie(cookie: string): string {
    return cookie.slice(cookie.indexOf('=') + 1);
  }

  async sessionRow(cookie: string): Promise<AuthSession | null> {
    return this.authDb.client.authSession.findUnique({
      where: { tokenHash: hashToken(this.tokenOfCookie(cookie)) },
    });
  }

  /** Emails queued for an address, oldest first, secrets opened. */
  async mails(to: string, template?: string): Promise<ParsedMail[]> {
    const { rows } = await this.superuser.query<{
      tenant_id: string;
      message_key: string;
      to: string;
      template: string;
      locale: string;
      event: string | null;
      template_vars: unknown;
    }>(
      `SELECT tenant_id, message_key, "to", template, locale, event, template_vars
         FROM message_logs
        WHERE "to" = $1 AND status = 'queued' ${template ? 'AND template = $2' : ''}
        ORDER BY created_at, id`,
      template ? [to, template] : [to],
    );
    return rows.map((r) => {
      const vars = openTemplateVars(this.sealer, r.tenant_id, r.message_key, r.template_vars);
      const link = ['verifyUrl', 'resetUrl', 'acceptUrl']
        .map((k) => vars[k])
        .find((v): v is string => typeof v === 'string');
      return {
        tenantId: r.tenant_id,
        messageKey: r.message_key,
        to: r.to,
        template: r.template,
        locale: r.locale,
        event: r.event,
        vars,
        token: link ? (new URL(link).searchParams.get('token') ?? undefined) : undefined,
        storedVars: r.template_vars,
      };
    });
  }

  async lastMail(to: string, template: string): Promise<ParsedMail> {
    const all = await this.mails(to, template);
    const mail = all.at(-1);
    if (!mail) throw new Error(`no ${template} mail was queued for ${to}`);
    return mail;
  }

  /** Count of `auth_requests` / `login_attempts` rows etc. through the superuser, for assertions. */
  async count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
    const { rows } = await this.superuser.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n);
  }

  async sql<T extends object = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.superuser.query<T>(text, params)).rows;
  }

  emailHash = hashEmail;
}

export const uniqueEmail = (prefix = 'user'): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.test`;

export const signupBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ali Khan',
  email: uniqueEmail('owner'),
  password: TEST_PASSWORD,
  tenantName: 'Royal Marquee',
  country: 'PK',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
  defaultLocale: 'en',
  ...overrides,
});
