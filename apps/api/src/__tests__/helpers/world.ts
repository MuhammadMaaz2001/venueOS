import { randomUUID } from 'node:crypto';
import { TenantDb } from '@venueos/db';
import type { TenantStatus } from '@venueos/db';
import { DEFAULT_ROLES } from '@venueos/shared';
import type { DefaultRoleDefinition, Permission, RoleLimits } from '@venueos/shared';

// Test fixtures: every test builds its own tenants through the app role (venueos_app) and TenantDb, so
// forced RLS applies to the fixtures too. Ids are unique per call; nothing depends on seed data.

type RoleKey = DefaultRoleDefinition['key'];

export interface TestTenant {
  id: string;
  /** Row ids of the five default roles, by key. */
  roles: Record<RoleKey, string>;
}

export interface TestMember {
  userId: string;
  membershipId: string;
  roleId: string;
}

const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export class World {
  readonly db: TenantDb;

  constructor(connectionString = process.env.DATABASE_URL as string) {
    this.db = new TenantDb({ connectionString });
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** A tenant with the five default roles and a subscription (`plan` = starter | growth | enterprise). */
  async createTenant(
    options: { status?: TenantStatus; plan?: 'starter' | 'growth' | 'enterprise' | null } = {},
  ): Promise<TestTenant> {
    const id = uid('tnt');
    const roles = {} as Record<RoleKey, string>;
    for (const def of DEFAULT_ROLES) roles[def.key] = uid('rol');

    // A fresh tenant has no owner row yet, so the context user is a throwaway id: RLS only needs
    // app.tenant_id to equal the row's own id for the insert to be accepted.
    await this.db.tx({ tenantId: id }, async (tx) => {
      await tx.tenant.create({
        data: {
          id,
          slug: id.replace(/_/g, '-'),
          name: `Test ${id}`,
          country: 'PK',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
          status: options.status ?? 'ACTIVE',
          settings: {},
        },
      });
      for (const def of DEFAULT_ROLES) {
        await tx.role.create({
          data: {
            id: roles[def.key],
            tenantId: id,
            name: def.name,
            permissions: [...def.permissions],
            limits: def.limits,
            isSystem: true,
          },
        });
      }
      if (options.plan !== null) {
        const plan = await tx.plan.findUniqueOrThrow({
          where: { code: options.plan ?? 'starter' },
        });
        const now = new Date();
        await tx.subscription.create({
          data: {
            tenantId: id,
            planId: plan.id,
            status: 'active',
            billingCycle: 'monthly',
            currentPeriodStart: now,
            currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
          },
        });
      }
    });
    return { id, roles };
  }

  /** A user row (no credentials: tests authenticate through the test stub). */
  async createUser(name = 'Test User'): Promise<string> {
    const id = uid('usr');
    await this.db.asUser(id, (tx) =>
      tx.user.create({
        data: { id, name, email: `${id}@example.test`, emailVerifiedAt: new Date() },
      }),
    );
    return id;
  }

  /** A member of `tenant`. `role` is a default role key, or an ad-hoc custom role definition. */
  async addMember(
    tenant: TestTenant,
    options: {
      role?: RoleKey | { name?: string; permissions: Permission[]; limits?: RoleLimits };
      venueIds?: string[];
      active?: boolean;
      userId?: string;
    } = {},
  ): Promise<TestMember> {
    const userId = options.userId ?? (await this.createUser());
    const membershipId = uid('mem');
    const spec = options.role ?? 'owner';
    let roleId: string;
    if (typeof spec === 'string') {
      roleId = tenant.roles[spec];
    } else {
      roleId = uid('rol');
      await this.db.tx({ tenantId: tenant.id, userId }, (tx) =>
        tx.role.create({
          data: {
            id: roleId,
            tenantId: tenant.id,
            name: spec.name ?? `Custom ${roleId}`,
            permissions: spec.permissions,
            limits: spec.limits ?? { maxDiscountPct: 0 },
            isSystem: false,
          },
        }),
      );
    }
    await this.db.tx({ tenantId: tenant.id, userId }, (tx) =>
      tx.membership.create({
        data: {
          id: membershipId,
          tenantId: tenant.id,
          userId,
          roleId,
          venueIds: options.venueIds ?? [],
          active: options.active ?? true,
        },
      }),
    );
    return { userId, membershipId, roleId };
  }

  async createVenue(tenant: TestTenant, options: { active?: boolean } = {}): Promise<string> {
    const id = uid('ven');
    await this.db.tx({ tenantId: tenant.id }, (tx) =>
      tx.venue.create({
        data: {
          id,
          tenantId: tenant.id,
          name: `Venue ${id}`,
          photoKeys: [],
          active: options.active ?? true,
        },
      }),
    );
    return id;
  }

  /** Replace a role's permissions directly (simulates an edit made elsewhere). */
  async setRolePermissions(
    tenant: TestTenant,
    roleId: string,
    permissions: Permission[],
  ): Promise<void> {
    await this.db.tx({ tenantId: tenant.id }, (tx) =>
      tx.role.updateMany({ where: { id: roleId, tenantId: tenant.id }, data: { permissions } }),
    );
  }

  async auditRows(tenant: TestTenant, where: { action?: string; entityId?: string } = {}) {
    return this.db.tx({ tenantId: tenant.id }, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: tenant.id, ...where },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}
