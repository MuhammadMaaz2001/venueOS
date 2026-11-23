import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantDb } from '@venueos/db';
import { isPermission, parseRoleLimits } from '@venueos/shared';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import {
  ForbiddenError,
  TenantSuspendedError,
  UnauthenticatedError,
} from '../errors/domain-errors';
import type { TenantAccess } from './access-context';
import { isPublicRoute } from './route-metadata';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Step 4 of the request lifecycle (docs/02, docs/04 section 3 layer 1). From the AuthContext's active
 * tenant it loads the caller's membership and role in a short TenantDb read (so RLS applies to this
 * lookup too), checks the membership and the tenant status, and stores `TenantAccess` in CLS.
 *
 *  - no membership in the active tenant (including another tenant's id) or inactive -> 403
 *  - SUSPENDED tenant: read-only; any method but GET/HEAD/OPTIONS -> 403 TENANT_SUSPENDED
 *  - CANCELLED tenant: every request -> 403
 *
 * Nothing is cached: a role edit or deactivation applies on the very next request. The tenant id never
 * comes from the request, only from the session's AuthContext (CLAUDE.md rule 1).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) return true;

    // AuthGuard runs first; if it did not fill this the guard chain is broken: fail closed.
    const auth = this.cls.get('auth');
    if (!auth) throw new UnauthenticatedError();
    if (!auth.activeTenantId) throw new ForbiddenError('Choose a workspace first.');
    const tenantId = auth.activeTenantId;

    const found = await this.tenantDb.tx({ tenantId, userId: auth.userId }, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { tenantId, userId: auth.userId },
        select: {
          id: true,
          active: true,
          venueIds: true,
          role: { select: { id: true, name: true, permissions: true, limits: true } },
        },
      });
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { status: true },
      });
      return { membership, tenant };
    });

    // Membership first: a non-member learns nothing about the tenant (not even its status).
    const { membership, tenant } = found;
    if (!membership?.active || !tenant) throw new ForbiddenError();

    if (tenant.status === 'CANCELLED') throw new ForbiddenError();
    const method = context.switchToHttp().getRequest<Request>().method;
    if (tenant.status === 'SUSPENDED' && !SAFE_METHODS.has(method)) {
      throw new TenantSuspendedError();
    }

    const access: TenantAccess = {
      tenantId,
      membershipId: membership.id,
      roleId: membership.role.id,
      roleName: membership.role.name,
      permissions: membership.role.permissions.filter(isPermission),
      venueIds: membership.venueIds,
      limits: parseRoleLimits(membership.role.limits),
    };
    this.cls.set('tenantId', tenantId);
    this.cls.set('access', access);
    return true;
  }
}
