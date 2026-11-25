import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuthDb, TenantDb } from '@venueos/db';
import { isPermission, parsePlanEntitlements, parseRoleLimits } from '@venueos/shared';
import type {
  AcceptInvitationNewUserInput,
  AcceptInvitationResponse,
  CreateInvitationInput,
  InvitationDto,
  InvitationListResponse,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { assertNoEscalation } from '../../common/access/escalation';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  BadRequestError,
  DuplicateError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  PlanLimitReachedError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { INVITATION_TTL_MS, hashToken, newToken } from './auth.constants';
import { PasswordService, assertPasswordAllowed } from './password.service';

const INVALID = 'This invitation is invalid or has expired.';

/**
 * Staff invitations (docs/04-security.md sections 1 and 2). A row of `invitations` (AuthDb: it is
 * auth-only) holds tenant, email, role, venues, the token HASH and the expiry (72 h); the raw token only
 * exists in the sealed link of the email. Creating, revoking and accepting are audited in the tenant.
 *
 * Plan limit: pending invitations count toward `maxUsers` (the guard on the route only sees memberships, so
 * the service re-checks under an advisory lock that serialises concurrent invitations of one tenant).
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly authDb: AuthDb,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: EmailOutbox,
    private readonly passwords: PasswordService,
    private readonly cls: ClsService<RequestContext>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  // ───────────────────────────── staff side ─────────────────────────────

  async create(input: CreateInvitationInput): Promise<InvitationDto> {
    const access = this.access;
    const { tenantId } = access;
    const userId = this.cls.get('userId');
    if (!userId) throw new UnauthenticatedError();
    const venueIds = [...new Set(input.venueIds)];

    // 1. Everything the client named is loaded in the tenant's context first (CLAUDE.md rule 13).
    const prepared = await this.tenantDb.tx(async (tx) => {
      const role = await tx.role.findFirst({ where: { id: input.roleId, tenantId } });
      if (!role) throw new NotFoundError();
      if (!role.active) {
        throw new InvalidStateTransitionError(
          'This role is retired and cannot be given to anyone.',
        );
      }
      if (venueIds.length > 0) {
        const found = await tx.venue.count({ where: { tenantId, id: { in: venueIds } } });
        if (found !== venueIds.length) throw new NotFoundError();
      }
      // A caller limited to some venues may only invite people into those venues, never "all venues".
      if (
        access.venueIds.length > 0 &&
        (venueIds.length === 0 || venueIds.some((v) => !access.venueIds.includes(v)))
      ) {
        throw new ForbiddenError('You can only invite people into your own venues.');
      }
      assertNoEscalation(
        access,
        role.permissions.filter(isPermission),
        [],
        parseRoleLimits(role.limits).maxDiscountPct,
        0,
      );

      const member = await tx.membership.findFirst({
        where: { tenantId, user: { email: input.email }, active: true },
        select: { id: true },
      });
      if (member) throw new DuplicateError('This person is already a member.');

      const subscription = await tx.subscription.findFirst({
        where: { tenantId, status: { not: 'cancelled' } },
        orderBy: { currentPeriodEnd: 'desc' },
        select: { plan: { select: { entitlements: true } } },
      });
      if (!subscription) {
        throw new PlanLimitReachedError('Your workspace has no active plan.', {
          resource: 'maxUsers',
        });
      }
      const [activeMembers, inviter, tenant] = await Promise.all([
        tx.membership.count({ where: { tenantId, active: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true, defaultLocale: true },
        }),
      ]);
      return {
        role,
        limit: parsePlanEntitlements(subscription.plan.entitlements).maxUsers,
        activeMembers,
        inviterName: inviter?.name ?? '',
        tenantName: tenant?.name ?? '',
        locale: tenant?.defaultLocale ?? 'en',
      };
    });

    // 2. The invitation row (AuthDb), serialised per tenant so the limit cannot be raced.
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await this.authDb.tx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
      const now = new Date();
      // An expired invitation is revoked here, so it neither blocks a new one nor counts toward the limit.
      await tx.invitation.updateMany({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { lte: now } },
        data: { revokedAt: now },
      });
      const pending = await tx.invitation.count({
        where: { tenantId, acceptedAt: null, revokedAt: null },
      });
      if (prepared.activeMembers + pending >= prepared.limit) {
        throw new PlanLimitReachedError('Your plan limit has been reached.', {
          resource: 'maxUsers',
          limit: prepared.limit,
          used: prepared.activeMembers + pending,
        });
      }
      try {
        return await tx.invitation.create({
          data: {
            tenantId,
            email: input.email,
            roleId: prepared.role.id,
            venueIds,
            tokenHash: hashToken(token),
            invitedById: userId,
            expiresAt,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError('This address already has a pending invitation.');
        }
        throw error;
      }
    });

    // 3. Audit and email in the tenant's transaction; if it fails the invitation is withdrawn again.
    try {
      await this.tenantDb.tx(async (tx) => {
        await this.audit.record(tx, {
          action: 'staff.invite',
          entityType: 'invitation',
          entityId: invitation.id,
          after: { email: input.email, roleId: prepared.role.id, venueIds },
        });
        await this.outbox.enqueue(tx, {
          to: input.email,
          template: 'staff.invite',
          locale: prepared.locale,
          vars: {
            inviterName: prepared.inviterName,
            tenantName: prepared.tenantName,
            roleName: prepared.role.name,
            days: INVITATION_TTL_MS / 86_400_000,
          },
          secretVars: {
            acceptUrl: `${this.config.APP_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`,
          },
          event: 'staff.invite',
          entityType: 'invitation',
          entityId: invitation.id,
        });
      });
    } catch (error) {
      await this.authDb.client.invitation.updateMany({
        where: { id: invitation.id },
        data: { revokedAt: new Date() },
      });
      throw error;
    }

    return {
      id: invitation.id,
      email: invitation.email,
      roleId: invitation.roleId,
      roleName: prepared.role.name,
      venueIds: invitation.venueIds,
      status: 'pending',
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  async list(): Promise<InvitationListResponse> {
    const { tenantId } = this.access;
    const rows = await this.authDb.client.invitation.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const roles = await this.tenantDb.tx((tx) =>
      tx.role.findMany({
        where: { tenantId, id: { in: [...new Set(rows.map((r) => r.roleId))] } },
        select: { id: true, name: true },
      }),
    );
    const names = new Map(roles.map((r) => [r.id, r.name]));
    const now = Date.now();
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        roleId: r.roleId,
        roleName: names.get(r.roleId) ?? null,
        venueIds: r.venueIds,
        status: r.expiresAt.getTime() > now ? ('pending' as const) : ('expired' as const),
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  }

  /** Revoking twice is fine; a foreign or unknown id is 404; an accepted invitation cannot be revoked. */
  async revoke(id: string): Promise<void> {
    const { tenantId } = this.access;
    const invitation = await this.authDb.client.invitation.findFirst({ where: { id, tenantId } });
    if (!invitation) throw new NotFoundError();
    if (invitation.acceptedAt) {
      throw new InvalidStateTransitionError('This invitation was already accepted.');
    }
    if (invitation.revokedAt) return;
    const changed = await this.authDb.client.invitation.updateMany({
      where: { id, tenantId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (changed.count !== 1) return;
    await this.tenantDb.tx((tx) =>
      this.audit.record(tx, {
        action: 'staff.invite.revoke',
        entityType: 'invitation',
        entityId: id,
        before: { email: invitation.email, roleId: invitation.roleId },
      }),
    );
  }

  // ───────────────────────────── invitee side ─────────────────────────────

  /** A person without an account accepts: name and password create the user (email verified by the token). */
  async acceptAsNewUser(input: AcceptInvitationNewUserInput): Promise<AcceptInvitationResponse> {
    assertPasswordAllowed(input.password);
    const passwordHash = await this.passwords.hash(input.password);
    const invitation = await this.findUsable(input.token);

    const existing = await this.authDb.client.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    if (existing) {
      throw new DuplicateError(
        'An account with this address already exists. Log in and accept the invitation from your account.',
      );
    }

    const userId = randomUUID();
    await this.authDb.tx(async (tx) => {
      await this.claim(tx, invitation.id);
      await tx.user.create({
        data: {
          id: userId,
          name: input.name,
          email: invitation.email,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.userCredential.create({ data: { userId, passwordHash } });
    });
    return this.addMembership(invitation, userId);
  }

  /** A logged-in user with an account accepts. The session's verified email must be the invited one. */
  async acceptAsExistingUser(userId: string, token: string): Promise<AcceptInvitationResponse> {
    const invitation = await this.findUsable(token);
    const user = await this.authDb.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthenticatedError();
    if (!user.emailVerifiedAt) throw new ForbiddenError('Confirm your email address first.');
    // Someone else's invitation answers like an invalid one: no hint that it exists.
    if (user.email !== invitation.email) throw new BadRequestError(INVALID);

    const already = await this.tenantDb.asUser(userId, (tx) =>
      tx.membership.findFirst({
        where: { tenantId: invitation.tenantId, userId },
        select: { active: true },
      }),
    );
    if (already?.active) throw new DuplicateError('You are already a member of this workspace.');

    await this.authDb.tx((tx) => this.claim(tx, invitation.id));
    return this.addMembership(invitation, userId);
  }

  private async findUsable(token: string) {
    const invitation = await this.authDb.client.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestError(INVALID);
    }
    return invitation;
  }

  /** Single use: the conditional update is the claim, so two parallel accepts cannot both win. */
  private async claim(tx: Pick<AuthDb['client'], 'invitation'>, id: string): Promise<void> {
    const claimed = await tx.invitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestError(INVALID);
  }

  /** The tenant side (membership + audit). If it fails the invitation is released so it can be retried. */
  private async addMembership(
    invitation: { id: string; tenantId: string; roleId: string; venueIds: string[]; email: string },
    userId: string,
  ): Promise<AcceptInvitationResponse> {
    const { tenantId } = invitation;
    try {
      await this.tenantDb.tx({ tenantId, userId }, async (tx) => {
        const tenant = await tx.tenant.findFirst({
          where: { id: tenantId },
          select: { status: true },
        });
        if (!tenant || tenant.status === 'CANCELLED') throw new BadRequestError(INVALID);
        // The role may have been retired since the invitation was sent: share-lock it, then check.
        await tx.$queryRaw`SELECT id FROM roles WHERE id = ${invitation.roleId} AND tenant_id = ${tenantId} FOR SHARE`;
        const role = await tx.role.findFirst({
          where: { id: invitation.roleId, tenantId },
          select: { active: true },
        });
        if (!role) throw new BadRequestError(INVALID);
        if (!role.active) {
          throw new InvalidStateTransitionError(
            'The role of this invitation has been retired. Ask for a new invitation.',
          );
        }
        const previous = await tx.membership.findFirst({ where: { tenantId, userId } });
        if (previous) {
          await tx.membership.update({
            where: { id: previous.id },
            data: { roleId: invitation.roleId, venueIds: invitation.venueIds, active: true },
          });
        } else {
          await tx.membership.create({
            data: { tenantId, userId, roleId: invitation.roleId, venueIds: invitation.venueIds },
          });
        }
        await this.audit.record(tx, {
          actor: 'USER',
          actorUserId: userId,
          tenantId,
          action: 'staff.invite.accept',
          entityType: 'invitation',
          entityId: invitation.id,
          after: { roleId: invitation.roleId, venueIds: invitation.venueIds },
        });
      });
    } catch (error) {
      await this.authDb.client.invitation.updateMany({
        where: { id: invitation.id },
        data: { acceptedAt: null },
      });
      throw error;
    }
    return { tenantId };
  }
}
