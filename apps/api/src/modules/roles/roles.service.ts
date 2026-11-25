import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import {
  OWNER_REQUIRED_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  parseRoleLimits,
} from '@venueos/shared';
import type {
  CreateRoleInput,
  Permission,
  RoleDto,
  RoleListQuery,
  RoleListResponse,
  UpdateRoleInput,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { assertNoEscalation } from '../../common/access/escalation';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  DuplicateError,
  InvalidStateTransitionError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
  limits: unknown;
  isSystem: boolean;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  /** Active members who hold the role. */
  _count: { memberships: number };
}

/** Every read of a role carries the number of its active members (the retire rule and the roles page). */
const WITH_MEMBER_COUNT = {
  _count: { select: { memberships: { where: { active: true } } } },
} as const;

const PERMISSION_ORDER = new Map<string, number>(PERMISSIONS.map((p, i) => [p, i]));

/** Known permissions only, no duplicates, in the documented order (stable output and audit diffs). */
function normalizePermissions(list: readonly string[]): Permission[] {
  return [...new Set(list)]
    .filter(isPermission)
    .sort((a, b) => (PERMISSION_ORDER.get(a) ?? 0) - (PERMISSION_ORDER.get(b) ?? 0));
}

function toDto(row: RoleRow): RoleDto {
  return {
    id: row.id,
    name: row.name,
    permissions: normalizePermissions(row.permissions),
    limits: parseRoleLimits(row.limits),
    isSystem: row.isSystem,
    active: row.active,
    memberCount: row._count.memberships,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class RolesService {
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

  async list(query: RoleListQuery): Promise<RoleListResponse> {
    const { tenantId } = this.access;
    const rows = await this.tenantDb.tx((tx) =>
      tx.role.findMany({
        where: {
          tenantId,
          ...(query.status === 'all' ? {} : { active: query.status === 'active' }),
        },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        include: WITH_MEMBER_COUNT,
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<RoleDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  /** A custom role starts as a copy of a role of the same tenant; edit it afterwards with PATCH. */
  async create(input: CreateRoleInput): Promise<RoleDto> {
    const access = this.access;
    try {
      return await this.tenantDb.tx(async (tx) => {
        // The id comes from the client and is not covered by a composite FK: load it first (rule 13).
        const source = await this.load(tx, input.copyFromRoleId);
        if (!source.active) {
          throw new InvalidStateTransitionError(
            'A retired role cannot be copied. Restore it first.',
          );
        }
        const permissions = normalizePermissions(source.permissions);
        const limits = parseRoleLimits(source.limits);
        // Copying must not hand out more than the caller holds (same rule as editing).
        assertNoEscalation(access, permissions, [], limits.maxDiscountPct, 0);

        await this.assertNameFree(tx, input.name);
        const created = await tx.role.create({
          data: {
            tenantId: access.tenantId,
            name: input.name,
            permissions,
            limits,
            isSystem: false,
          },
        });
        const dto = toDto({ ...created, _count: { memberships: 0 } });
        await this.audit.record(tx, {
          action: 'role.create',
          entityType: 'role',
          entityId: created.id,
          after: { ...dto, copiedFromRoleId: source.id },
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error)
        ? new DuplicateError('A role with this name already exists.')
        : error;
    }
  }

  async update(id: string, input: UpdateRoleInput): Promise<RoleDto> {
    const access = this.access;
    try {
      return await this.tenantDb.tx(async (tx) => {
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = toDto(current);

        const fieldsChanged =
          input.name !== undefined || input.permissions !== undefined || input.limits !== undefined;
        const nextActive = input.active ?? current.active;

        if (current.isSystem && input.name !== undefined && input.name !== current.name) {
          throw new InvalidStateTransitionError('The name of a system role cannot be changed.');
        }
        if (current.isSystem && !nextActive) {
          throw new InvalidStateTransitionError('A system role cannot be retired.');
        }
        // A retired role is frozen: restore it first (restoring and editing in one request is fine).
        if (!current.active && !nextActive && fieldsChanged) {
          throw new InvalidStateTransitionError(
            'A retired role cannot be edited. Restore it first.',
          );
        }

        const retiring = current.active && !nextActive;
        const restoring = !current.active && nextActive;
        if (retiring) {
          // Serialise with assignments (they share-lock the role): a member added a moment ago is counted.
          await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} FOR UPDATE`;
          const members = await tx.membership.count({
            where: { tenantId: access.tenantId, roleId: id, active: true },
          });
          if (members > 0) {
            throw new InvalidStateTransitionError(
              'This role still has active members. Move them to another role first.',
            );
          }
        }

        const nextPermissions =
          input.permissions === undefined
            ? before.permissions
            : normalizePermissions(input.permissions);
        const nextLimits = input.limits ?? before.limits;

        // Lock-out guard: the Owner role always keeps the permissions that manage roles and staff.
        if (current.isSystem && current.name === 'Owner') {
          const missing = OWNER_REQUIRED_PERMISSIONS.filter((p) => !nextPermissions.includes(p));
          if (missing.length > 0) {
            throw new InvalidStateTransitionError(
              `The Owner role must keep these permissions: ${OWNER_REQUIRED_PERMISSIONS.join(', ')}.`,
            );
          }
        }

        // Escalation guard: a caller can only add what they hold themselves.
        assertNoEscalation(
          access,
          nextPermissions,
          before.permissions,
          nextLimits.maxDiscountPct,
          before.limits.maxDiscountPct,
        );

        if (input.name !== undefined && input.name !== current.name) {
          await this.assertNameFree(tx, input.name);
        }

        const changed = await tx.role.updateMany({
          where: { id, tenantId: access.tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.permissions === undefined ? {} : { permissions: nextPermissions }),
            ...(input.limits === undefined ? {} : { limits: nextLimits }),
            ...(nextActive === current.active ? {} : { active: nextActive }),
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();

        const after = toDto(await this.load(tx, id));
        if (fieldsChanged) {
          await this.audit.record(tx, {
            action: 'role.update',
            entityType: 'role',
            entityId: id,
            before,
            after,
          });
        }
        if (retiring || restoring) {
          await this.audit.record(tx, {
            action: retiring ? 'role.retire' : 'role.restore',
            entityType: 'role',
            entityId: id,
            before: { name: before.name, active: before.active },
            after: { name: after.name, active: after.active },
          });
        }
        return after;
      });
    } catch (error) {
      throw isUniqueViolation(error)
        ? new DuplicateError('A role with this name already exists.')
        : error;
    }
  }

  /** Loads a role of the active tenant or 404 (another tenant's id answers the same as a missing one). */
  private async load(tx: DbTx, id: string): Promise<RoleRow> {
    const role = await tx.role.findFirst({
      where: { id, tenantId: this.access.tenantId },
      include: WITH_MEMBER_COUNT,
    });
    if (!role) throw new NotFoundError();
    return role;
  }

  private async assertNameFree(tx: DbTx, name: string): Promise<void> {
    const clash = await tx.role.findFirst({
      where: { tenantId: this.access.tenantId, name },
      select: { id: true },
    });
    if (clash) throw new DuplicateError('A role with this name already exists.');
  }
}
