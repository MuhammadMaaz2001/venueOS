import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { isPermission, parseRoleLimits } from '@venueos/shared';
import type { MeResponse, MeTenantsResponse, TenantSummary, UserSummary } from '@venueos/shared';
import type { AuthContext } from '../../common/access/access-context';
import { NotFoundError, UnauthenticatedError } from '../../common/errors/domain-errors';
import { SessionService } from './session.service';

/**
 * "Who am I and where am I working". These endpoints need a login but no tenant (`@AuthenticatedOnly()`),
 * so they read through `TenantDb.asUser()`: Row Level Security then shows the user their own row, their own
 * memberships and the tenants they belong to, and nothing else.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly sessions: SessionService,
  ) {}

  async me(auth: AuthContext): Promise<MeResponse> {
    return this.tenantDb.asUser(auth.userId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: auth.userId } });
      if (!user) throw new UnauthenticatedError();

      let access: MeResponse['access'] = null;
      if (auth.activeTenantId) {
        // Same facts the guards use, read inside the tenant's context so RLS applies to the role too.
        const found = await this.tenantDb.tx(
          { tenantId: auth.activeTenantId, userId: auth.userId },
          (inner) =>
            inner.membership.findFirst({
              where: { tenantId: auth.activeTenantId as string, userId: auth.userId },
              select: {
                active: true,
                venueIds: true,
                role: { select: { name: true, permissions: true, limits: true } },
              },
            }),
        );
        if (found?.active) {
          access = {
            tenantId: auth.activeTenantId,
            roleName: found.role.name,
            permissions: found.role.permissions.filter(isPermission),
            venueIds: found.venueIds,
            limits: parseRoleLimits(found.role.limits),
          };
        }
      }
      return {
        user: toUserSummary(user),
        activeTenantId: access ? auth.activeTenantId : null,
        access,
      };
    });
  }

  /** The workspaces the user is an active member of. */
  async listTenants(userId: string): Promise<TenantSummary[]> {
    return this.tenantDb.asUser(userId, async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { userId, active: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
              country: true,
              currency: true,
              timezone: true,
              defaultLocale: true,
            },
          },
        },
      });
      return memberships.map((m) => m.tenant);
    });
  }

  async tenants(auth: AuthContext): Promise<MeTenantsResponse> {
    return { data: await this.listTenants(auth.userId), activeTenantId: auth.activeTenantId };
  }

  /** The tenant a fresh login starts in: the only one when there is exactly one, otherwise none yet. */
  initialTenantId(tenants: readonly TenantSummary[]): string | null {
    return tenants.length === 1 ? (tenants[0]?.id ?? null) : null;
  }

  /**
   * Make `tenantId` the session's workspace. The token is rotated: the old one stops working at once.
   * A tenant the user is not an active member of answers 404, the same as one that does not exist.
   * @returns the new raw session token for the cookie
   */
  async switchTenant(auth: AuthContext, tenantId: string): Promise<string> {
    const member = await this.tenantDb.asUser(auth.userId, (tx) =>
      tx.membership.findFirst({
        where: { userId: auth.userId, tenantId, active: true },
        select: { id: true },
      }),
    );
    if (!member) throw new NotFoundError();
    const token = await this.sessions.rotate(auth.sessionId, tenantId);
    if (!token) throw new UnauthenticatedError();
    return token;
  }
}

export function toUserSummary(user: {
  id: string;
  name: string;
  email: string | null;
  emailVerifiedAt: Date | null;
}): UserSummary {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}
