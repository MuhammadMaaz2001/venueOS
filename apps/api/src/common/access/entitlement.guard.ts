import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { parsePlanEntitlements } from '@venueos/shared';
import type { EntitlementResource } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import { PlanLimitReachedError, UnauthenticatedError } from '../errors/domain-errors';
import { ENTITLEMENT_KEY } from './access.decorators';
import { isPublicRoute } from './route-metadata';

/** Current usage of each countable plan limit, read inside the tenant's own context (RLS applies). */
const USAGE: Record<EntitlementResource, (tx: DbTx, tenantId: string) => Promise<number>> = {
  maxVenues: (tx, tenantId) => tx.venue.count({ where: { tenantId, active: true } }),
  maxSpaces: (tx, tenantId) => tx.space.count({ where: { tenantId, active: true } }),
  maxUsers: (tx, tenantId) => tx.membership.count({ where: { tenantId, active: true } }),
};

/**
 * Step 6 of the request lifecycle (docs/02): only on create endpoints marked `@Entitlement(...)`.
 * Compares current usage with the plan limit in `plans.entitlements`; at or over the limit -> 402
 * PLAN_LIMIT_REACHED. A tenant without a live subscription has no allowance at all.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) return true;

    const resource = this.reflector.getAllAndOverride<EntitlementResource | undefined>(
      ENTITLEMENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (resource === undefined) return true;

    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    const { tenantId } = access;

    // Ambient context (CLS: tenantId and userId set by the earlier guards).
    const { subscription, used } = await this.tenantDb.tx(async (tx) => ({
      subscription: await tx.subscription.findFirst({
        where: { tenantId, status: { not: 'cancelled' } },
        orderBy: { currentPeriodEnd: 'desc' },
        select: { plan: { select: { entitlements: true } } },
      }),
      used: await USAGE[resource](tx, tenantId),
    }));

    if (!subscription) {
      throw new PlanLimitReachedError('Your workspace has no active plan.', { resource });
    }
    const limit = parsePlanEntitlements(subscription.plan.entitlements)[resource];
    if (used >= limit) {
      throw new PlanLimitReachedError('Your plan limit has been reached.', {
        resource,
        limit,
        used,
      });
    }
    return true;
  }
}
