import { z } from 'zod';

/**
 * Every permission name, grouped as in docs/04-security.md section 2 (that table is the source of
 * truth; `permissions.spec.ts` fails when this file and the table differ). Permissions are plain
 * strings like `booking.confirm`; roles are sets of them plus limits.
 */
export const PERMISSION_GROUPS = {
  tenant: [
    'tenant.settings.manage',
    'billing.manage',
    'staff.manage',
    'role.manage',
    'audit.view',
    'template.manage',
  ],
  setup: ['venue.manage', 'catalogue.manage', 'pricing.manage'],
  crm: ['customer.view', 'customer.manage', 'customer.view_sensitive', 'lead.view', 'lead.manage'],
  bookings: [
    'quotation.manage',
    'quotation.send',
    'booking.view',
    'booking.view_prices',
    'booking.create',
    'booking.edit',
    'booking.hold',
    'booking.extend_hold',
    'booking.confirm',
    'booking.confirm_override',
    'booking.cancel',
    'booking.edit_locked',
    'booking.override_rules',
  ],
  money: [
    'payment.view',
    'payment.record',
    'payment.reverse',
    'payment.refund.request',
    'payment.refund.approve',
  ],
  operations: [
    'eventsheet.view',
    'vendor.view',
    'vendor.manage',
    'expense.view',
    'expense.record',
    'expense.reverse',
    'inventory.view',
    'inventory.record',
    'inventory.adjust',
  ],
  reports: ['report.view', 'report.financial'],
} as const;

type Groups = typeof PERMISSION_GROUPS;

/** Union of all permission names. `@RequirePermission()` only accepts these. */
export type Permission = Groups[keyof Groups][number];

/** Flat list, in docs order. */
export const PERMISSIONS: readonly Permission[] = Object.values(PERMISSION_GROUPS).flat();

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

// z.enum needs a non-empty tuple type; the list above is non-empty by construction.
export const PermissionSchema = z.enum(PERMISSIONS as unknown as [Permission, ...Permission[]]);
