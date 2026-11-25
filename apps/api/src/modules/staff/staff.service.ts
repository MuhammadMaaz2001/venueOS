import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { isPermission, parsePlanEntitlements, parseRoleLimits } from '@venueos/shared';
import type {
  AssignableRolesResponse,
  StaffListResponse,
  StaffMemberDto,
  UpdateStaffInput,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { assertNoEscalation } from '../../common/access/escalation';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  PlanLimitReachedError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface MembershipRow {
  id: string;
  userId: string;
  roleId: string;
  venueIds: string[];
  active: boolean;
  rev: number;
  user: { name: string; email: string | null };
  role: { id: string; name: string; isSystem: boolean; permissions: string[]; limits: unknown };
}

const MEMBER_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  venueIds: true,
  active: true,
  rev: true,
  user: { select: { name: true, email: true } },
  role: { select: { id: true, name: true, isSystem: true, permissions: true, limits: true } },
} as const;

const isOwnerRole = (role: { isSystem: boolean; name: string }): boolean =>
  role.isSystem && role.name === 'Owner';

function toDto(row: MembershipRow): StaffMemberDto {
  return {
    membershipId: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    roleId: row.role.id,
    roleName: row.role.name,
    venueIds: row.venueIds,
    active: row.active,
    rev: row.rev,
  };
}

/**
 * The people of a tenant (`staff.manage`): list them, change role, venues or activation. Invitations are the
 * way in (AuthModule). Rules (docs/04-security.md section 2):
 *  - nobody grants a role whose permissions they lack, or venues outside their own scope;
 *  - nobody changes a member who has more access than they do;
 *  - **a tenant always keeps at least one active Owner**: deactivating the last one or moving them to another
 *    role is 422. The check runs under a lock on the tenant row, so two owners cannot remove each other at
 *    the same moment.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  async list(): Promise<StaffListResponse> {
    const access = this.access;
    const rows = await this.tenantDb.tx((tx) =>
      tx.membership.findMany({
        where: {
          tenantId: access.tenantId,
          // A caller limited to some venues sees the people whose scope touches theirs (or is "all").
          ...(access.venueIds.length > 0
            ? {
                OR: [
                  { venueIds: { isEmpty: true } },
                  { venueIds: { hasSome: [...access.venueIds] } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: MEMBER_SELECT,
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  /**
   * The roles the caller may give to someone: the same no-escalation rule that inviting and PATCH apply, so the
   * pickers of the web app never offer a role the API would refuse. Needs only `staff.manage` (`GET /v1/roles`
   * needs `role.manage` and returns the permission sets, which a staff manager does not need to see).
   */
  async assignableRoles(): Promise<AssignableRolesResponse> {
    const access = this.access;
    const roles = await this.tenantDb.tx((tx) =>
      tx.role.findMany({
        // Retired roles are never offered (module 2).
        where: { tenantId: access.tenantId, active: true },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, permissions: true, limits: true },
      }),
    );
    const data = roles
      .filter((role) => {
        try {
          assertNoEscalation(
            access,
            role.permissions.filter(isPermission),
            [],
            parseRoleLimits(role.limits).maxDiscountPct,
            0,
          );
          return true;
        } catch {
          return false;
        }
      })
      .map((role) => ({ id: role.id, name: role.name }));
    return { data };
  }

  async update(membershipId: string, input: UpdateStaffInput): Promise<StaffMemberDto> {
    const access = this.access;
    const { tenantId } = access;

    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, membershipId);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = toDto(current);
      this.assertMayManage(access, current);

      // The role to assign is loaded through TenantDb first (a client-supplied id, CLAUDE.md rule 13).
      const nextRole =
        input.roleId === undefined || input.roleId === current.roleId
          ? current.role
          : await this.loadRole(tx, tenantId, input.roleId);
      if (nextRole !== current.role) {
        assertNoEscalation(
          access,
          nextRole.permissions.filter(isPermission),
          [],
          parseRoleLimits(nextRole.limits).maxDiscountPct,
          0,
        );
      }

      const nextVenueIds =
        input.venueIds === undefined ? current.venueIds : [...new Set(input.venueIds)];
      if (input.venueIds !== undefined) await this.assertVenues(tx, access, nextVenueIds);
      const nextActive = input.active ?? current.active;

      // Owner invariant: serialise on the tenant row, then count the OTHER active owners.
      const staysActiveOwner = nextActive && isOwnerRole(nextRole);
      if (current.active && isOwnerRole(current.role) && !staysActiveOwner) {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
        const otherOwners = await tx.membership.count({
          where: {
            tenantId,
            active: true,
            id: { not: current.id },
            role: { isSystem: true, name: 'Owner' },
          },
        });
        if (otherOwners === 0) {
          throw new InvalidStateTransitionError(
            'A workspace must keep at least one active Owner. Make someone else an Owner first.',
          );
        }
      }

      if (nextActive && !current.active) await this.assertRoomForOneMore(tx, tenantId);

      const changed = await tx.membership.updateMany({
        where: { id: membershipId, tenantId, rev: input.rev },
        data: {
          ...(nextRole.id === current.roleId ? {} : { roleId: nextRole.id }),
          ...(input.venueIds === undefined ? {} : { venueIds: nextVenueIds }),
          ...(nextActive === current.active ? {} : { active: nextActive }),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();

      const after = toDto(await this.load(tx, membershipId));
      await this.audit.record(tx, {
        action: 'staff.update',
        entityType: 'membership',
        entityId: membershipId,
        before,
        after,
      });
      return after;
    });
  }

  /** A membership of the active tenant, or 404 (another tenant's id answers like a missing one). */
  private async load(tx: DbTx, id: string): Promise<MembershipRow> {
    const row = await tx.membership.findFirst({
      where: { id, tenantId: this.access.tenantId },
      select: MEMBER_SELECT,
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  /** A role to assign: of this tenant and not retired. Share-locked so a concurrent retire sees the new member. */
  private async loadRole(tx: DbTx, tenantId: string, id: string): Promise<MembershipRow['role']> {
    await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} AND tenant_id = ${tenantId} FOR SHARE`;
    const role = await tx.role.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        name: true,
        isSystem: true,
        active: true,
        permissions: true,
        limits: true,
      },
    });
    if (!role) throw new NotFoundError();
    if (!role.active) {
      throw new InvalidStateTransitionError('This role is retired and cannot be given to anyone.');
    }
    return role;
  }

  /** Nobody manages a member whose role, or venue scope, is wider than their own. */
  private assertMayManage(access: TenantAccess, target: MembershipRow): void {
    try {
      assertNoEscalation(
        access,
        target.role.permissions.filter(isPermission),
        [],
        parseRoleLimits(target.role.limits).maxDiscountPct,
        0,
      );
    } catch {
      throw new ForbiddenError('You cannot manage a member who has more access than you.');
    }
    if (
      access.venueIds.length > 0 &&
      (target.venueIds.length === 0 || target.venueIds.some((v) => !access.venueIds.includes(v)))
    ) {
      throw new ForbiddenError('You cannot manage a member who has access outside your venues.');
    }
  }

  /** New venue scope: every id must be a venue of the tenant, and a limited caller stays inside their own. */
  private async assertVenues(
    tx: DbTx,
    access: TenantAccess,
    venueIds: readonly string[],
  ): Promise<void> {
    if (venueIds.length > 0) {
      const found = await tx.venue.count({
        where: { tenantId: access.tenantId, id: { in: [...venueIds] } },
      });
      if (found !== venueIds.length) throw new NotFoundError();
    }
    if (
      access.venueIds.length > 0 &&
      (venueIds.length === 0 || venueIds.some((v) => !access.venueIds.includes(v)))
    ) {
      throw new ForbiddenError('You can only give access to your own venues.');
    }
  }

  /** Re-activating a member uses a seat of the plan (pending invitations are checked when inviting). */
  private async assertRoomForOneMore(tx: DbTx, tenantId: string): Promise<void> {
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
    const limit = parsePlanEntitlements(subscription.plan.entitlements).maxUsers;
    const used = await tx.membership.count({ where: { tenantId, active: true } });
    if (used >= limit) {
      throw new PlanLimitReachedError('Your plan limit has been reached.', {
        resource: 'maxUsers',
        limit,
        used,
      });
    }
  }
}
