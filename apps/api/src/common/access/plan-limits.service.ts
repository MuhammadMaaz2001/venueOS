import { Injectable } from '@nestjs/common';
import type { DbTx } from '@venueos/db';
import { parsePlanEntitlements } from '@venueos/shared';
import { PlanLimitReachedError } from '../errors/domain-errors';

/** The countable limits that services re-check strictly (the guard's check on the route is only the first line). */
type StrictResource = 'maxVenues' | 'maxSpaces';

/**
 * The strict half of `@Entitlement(...)`: the guard answers 402 early, but two requests can pass it at the
 * same moment. A service that creates (or re-activates) a counted row calls this INSIDE its transaction; the
 * lock on the tenant row makes the count-then-insert atomic per tenant.
 */
@Injectable()
export class PlanLimits {
  async assertRoom(tx: DbTx, tenantId: string, resource: StrictResource): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
    const subscription = await tx.subscription.findFirst({
      where: { tenantId, status: { not: 'cancelled' } },
      orderBy: { currentPeriodEnd: 'desc' },
      select: { plan: { select: { entitlements: true } } },
    });
    if (!subscription) {
      throw new PlanLimitReachedError('Your workspace has no active plan.', { resource });
    }
    const limit = parsePlanEntitlements(subscription.plan.entitlements)[resource];
    const used =
      resource === 'maxVenues'
        ? await tx.venue.count({ where: { tenantId, active: true } })
        : await tx.space.count({ where: { tenantId, active: true } });
    if (used >= limit) {
      throw new PlanLimitReachedError('Your plan limit has been reached.', {
        resource,
        limit,
        used,
      });
    }
  }
}
