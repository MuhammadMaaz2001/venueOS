import { z } from 'zod';
import { PERMISSIONS } from './permissions.js';
import type { Permission } from './permissions.js';

/**
 * Value limits attached to a role (docs/04-security.md section 2). `maxDiscountPct` caps the
 * discount a holder may give; an absent value means 0 (docs/05-business-rules.md section 5).
 */
export const RoleLimitsSchema = z.object({
  maxDiscountPct: z.number().min(0).max(100).default(0),
});
export type RoleLimits = z.infer<typeof RoleLimitsSchema>;

/** Safe read of `roles.limits` (JSONB). Garbage or a missing key never grants more than 0%. */
export function parseRoleLimits(raw: unknown): RoleLimits {
  const result = RoleLimitsSchema.safeParse(raw ?? {});
  return result.success ? result.data : { maxDiscountPct: 0 };
}

export interface DefaultRoleDefinition {
  /** Stable key. The seed derives its fixed row id from it (`seed_role_<key>`). */
  readonly key: 'owner' | 'branch_manager' | 'sales_agent' | 'accountant' | 'operations';
  readonly name: string;
  readonly permissions: readonly Permission[];
  readonly limits: RoleLimits;
}

/**
 * The five roles every tenant starts with (`is_system = true`), mirrored in docs/01-product-scope.md
 * ("Roles"). Tenants copy and edit them; the names of system roles stay locked.
 */
export const DEFAULT_ROLES: readonly DefaultRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    permissions: PERMISSIONS,
    limits: { maxDiscountPct: 100 },
  },
  {
    key: 'branch_manager',
    name: 'Branch manager',
    permissions: [
      'venue.view',
      'venue.manage',
      'catalogue.view',
      'catalogue.manage',
      'pricing.view',
      'pricing.manage',
      'customer.view',
      'customer.manage',
      'lead.view',
      'lead.manage',
      'quotation.manage',
      'quotation.send',
      'booking.view',
      'booking.view_prices',
      'booking.create',
      'booking.edit',
      'booking.hold',
      'booking.extend_hold',
      'booking.confirm',
      'booking.cancel',
      'booking.edit_locked',
      'payment.view',
      'payment.record',
      'payment.refund.request',
      'eventsheet.view',
      'vendor.view',
      'vendor.manage',
      'expense.view',
      'expense.record',
      'inventory.view',
      'inventory.record',
      'inventory.adjust',
      'report.view',
      'report.financial',
    ],
    limits: { maxDiscountPct: 15 },
  },
  {
    key: 'sales_agent',
    name: 'Sales agent',
    permissions: [
      'venue.view',
      'catalogue.view',
      'pricing.view',
      'customer.view',
      'customer.manage',
      'lead.view',
      'lead.manage',
      'quotation.manage',
      'quotation.send',
      'booking.view',
      'booking.view_prices',
      'booking.create',
      'booking.edit',
      'booking.hold',
      'booking.extend_hold',
      'booking.confirm',
      'payment.view',
      'eventsheet.view',
      'vendor.view',
    ],
    limits: { maxDiscountPct: 5 },
  },
  {
    key: 'accountant',
    name: 'Accountant',
    permissions: [
      'venue.view',
      'catalogue.view',
      'pricing.view',
      'customer.view',
      'booking.view',
      'booking.view_prices',
      'payment.view',
      'payment.record',
      'payment.reverse',
      'payment.refund.request',
      'payment.refund.approve',
      'expense.view',
      'expense.record',
      'expense.reverse',
      'vendor.view',
      'report.view',
      'report.financial',
    ],
    limits: { maxDiscountPct: 0 },
  },
  {
    key: 'operations',
    name: 'Operations',
    permissions: [
      'venue.view',
      'catalogue.view',
      'eventsheet.view',
      'booking.view',
      'vendor.view',
      'inventory.view',
      'inventory.record',
    ],
    limits: { maxDiscountPct: 0 },
  },
];

/**
 * Permissions the Owner role can never lose, so a tenant cannot lock itself out of managing roles and
 * staff (enforced by the role endpoints).
 */
export const OWNER_REQUIRED_PERMISSIONS: readonly Permission[] = ['role.manage', 'staff.manage'];

/** Plan limits (`plans.entitlements`, JSONB). Missing or invalid keys read as "nothing allowed". */
export const PlanEntitlementsSchema = z.object({
  maxVenues: z.number().int().min(0).default(0),
  maxSpaces: z.number().int().min(0).default(0),
  maxUsers: z.number().int().min(0).default(0),
  emailsPerMonth: z.number().int().min(0).default(0),
  customDomain: z.boolean().default(false),
});
export type PlanEntitlements = z.infer<typeof PlanEntitlementsSchema>;

/** The countable limits an `@Entitlement()` marker can name. */
export const ENTITLEMENT_RESOURCES = ['maxVenues', 'maxSpaces', 'maxUsers'] as const;
export type EntitlementResource = (typeof ENTITLEMENT_RESOURCES)[number];

export function parsePlanEntitlements(raw: unknown): PlanEntitlements {
  const result = PlanEntitlementsSchema.safeParse(raw ?? {});
  return result.success ? result.data : PlanEntitlementsSchema.parse({});
}
