import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuthDb, TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { DEFAULT_ROLES } from '@venueos/shared';
import type {
  ChangePasswordInput,
  LoginInput,
  LoginResponse,
  ResetPasswordInput,
  SignupInput,
} from '@venueos/shared';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  BadRequestError,
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { AbuseLimitsService } from './abuse-limits.service';
import {
  EMAIL_VERIFY_TTL_MS,
  LOGIN_LOCK_MS,
  LOGIN_MAX_ATTEMPTS_PER_IP,
  LOGIN_MAX_FAILURES_PER_EMAIL,
  LOGIN_WINDOW_MS,
  PASSWORD_RESET_TTL_MS,
  TRIAL_DAYS,
  TRIAL_PLAN_CODE,
  hashEmail,
  hashToken,
  newToken,
} from './auth.constants';
import { AuthMailer } from './auth-mailer.service';
import type { MailRecipient } from './auth-mailer.service';
import { MeService, toUserSummary } from './me.service';
import { PasswordService, assertPasswordAllowed } from './password.service';
import { SessionService } from './session.service';

const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

export interface RequestInfo {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface LoginResult {
  /** The raw session token for the cookie. */
  sessionToken: string;
  body: LoginResponse;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

/**
 * Accounts and sessions: signup, email verification, login, logout, password reset and change
 * (docs/04-security.md section 1, docs/09 P0-4). Everything about credentials goes through AuthDb; the
 * tenant side of signup goes through TenantDb in its own transaction (different role, so never one).
 *
 * Enumeration safety: signup, resend-verification and password/forgot answer the same whether or not the
 * address has an account, and login answers the same for an unknown address, a wrong password and a locked
 * account (a real hash check runs in every case so the timing does not tell either).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly authDb: AuthDb,
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limits: AbuseLimitsService,
    private readonly mailer: AuthMailer,
    private readonly outbox: EmailOutbox,
    private readonly audit: AuditService,
    private readonly me: MeService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  // ───────────────────────────── signup and verification ─────────────────────────────

  /** Always resolves the same way; the HTTP answer is 202 whatever happened. */
  async signup(input: SignupInput, request: RequestInfo): Promise<void> {
    assertPasswordAllowed(input.password);
    // Hash first, always: a request for a new address and one for an existing address take equally long.
    const passwordHash = await this.passwords.hash(input.password);
    if (!(await this.limits.allow('signup', input.email, request.ip))) return;

    const existing = await this.authDb.client.user.findUnique({ where: { email: input.email } });
    if (!existing) {
      try {
        await this.createAccount(input, passwordHash);
      } catch (error) {
        // Lost a race with a parallel signup for the same address: that one wins, nothing more to do.
        if (!isUniqueViolation(error)) throw error;
      }
      return;
    }
    const recipient: MailRecipient = {
      userId: existing.id,
      email: input.email,
      name: existing.name,
    };
    if (existing.emailVerifiedAt) {
      await this.mailer.sendAccountExists(recipient);
      return;
    }
    await this.restartUnverifiedSignup(existing.id, input, passwordHash);
  }

  /** User, credentials and verification token (AuthDb), then the tenant side (TenantDb). */
  private async createAccount(input: SignupInput, passwordHash: string): Promise<void> {
    const userId = randomUUID();
    const token = newToken();
    await this.authDb.tx(async (tx) => {
      await tx.user.create({ data: { id: userId, name: input.name, email: input.email } });
      await tx.userCredential.create({ data: { userId, passwordHash } });
      await this.createVerifyToken(tx, userId, token);
    });
    await this.createTenantFor(userId, input, token);
  }

  /**
   * The address signed up before and never verified. Only the mailbox owner can verify, so the LATEST signup
   * wins: it replaces the name and password (an attacker who pre-registered someone's address cannot keep
   * the account), invalidates earlier tokens and sends a fresh verification mail. If the first attempt died
   * before its tenant was created, the tenant is created now.
   */
  private async restartUnverifiedSignup(
    userId: string,
    input: SignupInput,
    passwordHash: string,
  ): Promise<void> {
    const token = newToken();
    await this.authDb.tx(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { name: input.name } });
      await tx.userCredential.upsert({
        where: { userId },
        create: { userId, passwordHash },
        update: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.createVerifyToken(tx, userId, token);
    });
    const hasWorkspace = await this.tenantDb.asUser(
      userId,
      async (tx) => (await tx.membership.count({ where: { userId } })) > 0,
    );
    if (hasWorkspace) {
      await this.mailer.sendVerification({ userId, email: input.email, name: input.name }, token);
    } else {
      await this.createTenantFor(userId, input, token);
    }
  }

  private async createVerifyToken(tx: DbTx, userId: string, token: string): Promise<void> {
    await tx.authToken.updateMany({
      where: { userId, purpose: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.authToken.create({
      data: {
        userId,
        purpose: 'EMAIL_VERIFY',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });
  }

  /**
   * One TenantDb transaction: the tenant (its id pre-generated so `app.tenant_id` can be set before the row
   * exists), the five default roles, the owner membership, a trial subscription, the audit row and the
   * verification mail. The slug is retried when it collides.
   */
  private async createTenantFor(userId: string, input: SignupInput, token: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const tenantId = randomUUID();
      const slug = `${slugify(input.tenantName)}-${randomBytes(3).toString('hex')}`;
      try {
        await this.tenantDb.tx({ tenantId, userId }, async (tx) => {
          const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
          await tx.tenant.create({
            data: {
              id: tenantId,
              slug,
              name: input.tenantName,
              country: input.country,
              currency: input.currency,
              timezone: input.timezone,
              defaultLocale: input.defaultLocale,
              status: 'TRIAL',
              trialEndsAt,
            },
          });
          let ownerRoleId = '';
          for (const def of DEFAULT_ROLES) {
            const role = await tx.role.create({
              data: {
                tenantId,
                name: def.name,
                permissions: [...def.permissions],
                limits: def.limits,
                isSystem: true,
              },
              select: { id: true },
            });
            if (def.key === 'owner') ownerRoleId = role.id;
          }
          await tx.membership.create({
            data: { tenantId, userId, roleId: ownerRoleId, venueIds: [] },
          });
          const plan = await tx.plan.findUnique({ where: { code: TRIAL_PLAN_CODE } });
          if (!plan) throw new Error(`signup: plan "${TRIAL_PLAN_CODE}" is missing (run the seed)`);
          await tx.subscription.create({
            data: {
              tenantId,
              planId: plan.id,
              status: 'active',
              billingCycle: 'monthly',
              currentPeriodStart: new Date(),
              currentPeriodEnd: trialEndsAt,
            },
          });
          await this.audit.record(tx, {
            actor: 'USER',
            actorUserId: userId,
            tenantId,
            action: 'tenant.signup',
            entityType: 'tenant',
            entityId: tenantId,
            after: { name: input.tenantName, slug, plan: TRIAL_PLAN_CODE, trialEndsAt },
          });
          await this.outbox.enqueueForTenant(
            tx,
            tenantId,
            this.mailer.verificationMail(
              { userId, email: input.email, name: input.name },
              input.defaultLocale,
              token,
            ),
          );
        });
        return;
      } catch (error) {
        // `slug` is the only value that can collide (the id is random): try another suffix.
        if (!isUniqueViolation(error) || attempt >= 4) throw error;
      }
    }
  }

  async verifyEmail(token: string): Promise<void> {
    await this.authDb.tx(async (tx) => {
      const row = await tx.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
      if (
        !row ||
        row.purpose !== 'EMAIL_VERIFY' ||
        row.usedAt !== null ||
        row.expiresAt.getTime() <= Date.now()
      ) {
        throw new BadRequestError('This link is invalid or has expired.');
      }
      // Single use: the conditional update is the claim, so two parallel requests cannot both succeed.
      const claimed = await tx.authToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new BadRequestError('This link is invalid or has expired.');
      await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
    });
  }

  /** Always resolves the same way (202). */
  async resendVerification(email: string, request: RequestInfo): Promise<void> {
    if (!(await this.limits.allow('resend_verification', email, request.ip))) return;
    const user = await this.authDb.client.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const token = newToken();
    await this.authDb.tx((tx) => this.createVerifyToken(tx, user.id, token));
    await this.mailer.sendVerification({ userId: user.id, email, name: user.name }, token);
  }

  // ───────────────────────────── login and sessions ─────────────────────────────

  async login(
    input: LoginInput,
    request: RequestInfo,
    presentedSessionId: string | undefined,
  ): Promise<LoginResult> {
    const now = Date.now();
    const emailHash = hashEmail(input.email);
    const { loginAttempt, user: users } = this.authDb.client;

    if (request.ip) {
      const fromIp = await loginAttempt.count({
        where: { ip: request.ip, createdAt: { gte: new Date(now - LOGIN_WINDOW_MS) } },
      });
      if (fromIp >= LOGIN_MAX_ATTEMPTS_PER_IP) throw new RateLimitedError();
    }

    const user = await users.findUnique({
      where: { email: input.email },
      include: { credentials: true },
    });
    const credentials = user?.credentials ?? null;
    const recentFailures = await loginAttempt.count({
      where: {
        emailHash,
        succeeded: false,
        createdAt: { gte: new Date(now - LOGIN_WINDOW_MS) },
      },
    });
    const locked =
      recentFailures >= LOGIN_MAX_FAILURES_PER_EMAIL ||
      (credentials?.lockedUntil !== null && (credentials?.lockedUntil?.getTime() ?? 0) > now);

    // A real hash check in every case (unknown address, locked account, wrong password): same time, same answer.
    const passwordOk =
      credentials && !locked
        ? await this.passwords.verify(input.password, credentials.passwordHash)
        : await this.passwords.verifyDummy(input.password);

    if (!user || !credentials || locked || !passwordOk) {
      await loginAttempt.create({ data: { emailHash, ip: request.ip ?? null, succeeded: false } });
      if (user && credentials && !locked) {
        const failures = recentFailures + 1;
        await this.authDb.client.userCredential.update({
          where: { userId: user.id },
          data: {
            failedLoginCount: { increment: 1 },
            ...(failures >= LOGIN_MAX_FAILURES_PER_EMAIL
              ? { lockedUntil: new Date(now + LOGIN_LOCK_MS) }
              : {}),
          },
        });
      }
      throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
    }

    // The password is right. Count it as a successful attempt, clear the failure state, upgrade the hash.
    await loginAttempt.create({ data: { emailHash, ip: request.ip ?? null, succeeded: true } });
    await this.authDb.client.userCredential.update({
      where: { userId: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(this.passwords.needsRehash(credentials.passwordHash)
          ? { passwordHash: await this.passwords.hash(input.password) }
          : {}),
      },
    });

    if (!user.emailVerifiedAt) {
      throw new ForbiddenError('Confirm your email address first. Check your inbox.', {
        reason: 'EMAIL_NOT_VERIFIED',
      });
    }

    // Fixation defence: a login never reuses a token, and the session it was called with (if any) dies.
    if (presentedSessionId) await this.sessions.revoke(presentedSessionId);
    const tenants = await this.me.listTenants(user.id);
    const activeTenantId = this.me.initialTenantId(tenants);
    const session = await this.sessions.create({
      userId: user.id,
      activeTenantId,
      ip: request.ip,
      userAgent: request.userAgent,
    });
    return {
      sessionToken: session.token,
      body: { user: toUserSummary(user), activeTenantId, tenants },
    };
  }

  logout(sessionId: string): Promise<void> {
    return this.sessions.revoke(sessionId);
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }

  // ───────────────────────────── passwords ─────────────────────────────

  /** Always resolves the same way (202). */
  async forgotPassword(email: string, request: RequestInfo): Promise<void> {
    if (!(await this.limits.allow('password_forgot', email, request.ip))) return;
    const user = await this.authDb.client.user.findUnique({
      where: { email },
      include: { credentials: { select: { userId: true } } },
    });
    if (!user || !user.credentials) return;

    const token = newToken();
    await this.authDb.tx(async (tx) => {
      await tx.authToken.updateMany({
        where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authToken.create({
        data: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
    });
    await this.mailer.sendPasswordReset({ userId: user.id, email, name: user.name }, token);
  }

  /** Single-use token; sets the password, clears any lock, revokes EVERY session of the user. */
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    assertPasswordAllowed(input.newPassword, 'newPassword');
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.authDb.tx(async (tx) => {
      const row = await tx.authToken.findUnique({ where: { tokenHash: hashToken(input.token) } });
      if (
        !row ||
        row.purpose !== 'PASSWORD_RESET' ||
        row.usedAt !== null ||
        row.expiresAt.getTime() <= Date.now()
      ) {
        throw new BadRequestError('This link is invalid or has expired.');
      }
      const claimed = await tx.authToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new BadRequestError('This link is invalid or has expired.');

      await tx.userCredential.upsert({
        where: { userId: row.userId },
        create: { userId: row.userId, passwordHash, passwordChangedAt: new Date() },
        update: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      // Receiving the mail proves the mailbox.
      await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      await tx.authSession.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /** Wrong current password: 403 and it counts toward the lock (a stolen session cannot guess it freely). */
  async changePassword(
    userId: string,
    sessionId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    assertPasswordAllowed(input.newPassword, 'newPassword');
    const user = await this.authDb.client.user.findUnique({
      where: { id: userId },
      include: { credentials: true },
    });
    const credentials = user?.credentials;
    if (!user || !credentials) throw new UnauthenticatedError();

    const locked =
      credentials.lockedUntil !== null && credentials.lockedUntil.getTime() > Date.now();
    const ok = locked
      ? await this.passwords.verifyDummy(input.currentPassword)
      : await this.passwords.verify(input.currentPassword, credentials.passwordHash);
    if (!ok) {
      if (!locked) {
        const failures = credentials.failedLoginCount + 1;
        await this.authDb.client.userCredential.update({
          where: { userId },
          data: {
            failedLoginCount: { increment: 1 },
            ...(failures >= LOGIN_MAX_FAILURES_PER_EMAIL
              ? { lockedUntil: new Date(Date.now() + LOGIN_LOCK_MS) }
              : {}),
          },
        });
      }
      throw new ForbiddenError('Your current password is incorrect.');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.authDb.tx(async (tx) => {
      await tx.userCredential.update({
        where: { userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
    });
    await this.sessions.revokeAllForUser(userId, sessionId);
  }
}
