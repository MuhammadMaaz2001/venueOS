import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PermissionSchema,
  isPermission,
  missingViewPermissions,
  requiredViewPermission,
} from './permissions.js';
import { UpdateRoleSchema } from './schemas/roles.js';
import {
  DEFAULT_ROLES,
  OWNER_REQUIRED_PERMISSIONS,
  parsePlanEntitlements,
  parseRoleLimits,
} from './roles.js';

describe('permissions', () => {
  it('has 46 unique names of the form area.action', () => {
    expect(PERMISSIONS).toHaveLength(46);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(p).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  it('isPermission and PermissionSchema accept only listed names', () => {
    expect(isPermission('booking.confirm')).toBe(true);
    expect(isPermission('booking.explode')).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(PermissionSchema.safeParse('payment.refund.approve').success).toBe(true);
    expect(PermissionSchema.safeParse('constructor').success).toBe(false);
  });
});

describe('default roles', () => {
  it('are the five documented roles with unique keys and names', () => {
    expect(DEFAULT_ROLES.map((r) => r.name)).toEqual([
      'Owner',
      'Branch manager',
      'Sales agent',
      'Accountant',
      'Operations',
    ]);
    expect(new Set(DEFAULT_ROLES.map((r) => r.key)).size).toBe(5);
  });

  it('only use real permissions, without duplicates', () => {
    for (const role of DEFAULT_ROLES) {
      expect(new Set(role.permissions).size, role.name).toBe(role.permissions.length);
      for (const p of role.permissions) expect(isPermission(p), `${role.name}: ${p}`).toBe(true);
    }
  });

  it('give the Owner everything, including the lock-out permissions', () => {
    const owner = DEFAULT_ROLES.find((r) => r.key === 'owner');
    expect([...(owner?.permissions ?? [])].sort()).toEqual([...PERMISSIONS].sort());
    expect(owner?.limits.maxDiscountPct).toBe(100);
    for (const p of OWNER_REQUIRED_PERMISSIONS) expect(owner?.permissions).toContain(p);
  });

  it('keep the override permissions and billing Owner-only', () => {
    for (const role of DEFAULT_ROLES.filter((r) => r.key !== 'owner')) {
      for (const p of [
        'booking.confirm_override',
        'booking.override_rules',
        'billing.manage',
      ] as const) {
        expect(role.permissions, `${role.name} must not have ${p}`).not.toContain(p);
      }
    }
  });

  it('match the agreed discount limits and per-role additions', () => {
    const by = (key: string) => DEFAULT_ROLES.find((r) => r.key === key);
    expect(by('branch_manager')?.limits.maxDiscountPct).toBe(15);
    expect(by('sales_agent')?.limits.maxDiscountPct).toBe(5);
    expect(by('accountant')?.limits.maxDiscountPct).toBe(0);
    expect(by('operations')?.limits.maxDiscountPct).toBe(0);
    expect(by('sales_agent')?.permissions).toEqual(
      expect.arrayContaining(['booking.confirm', 'payment.view', 'eventsheet.view', 'vendor.view']),
    );
    expect(by('sales_agent')?.permissions).not.toContain('payment.record');
    expect(by('branch_manager')?.permissions).toEqual(
      expect.arrayContaining(['inventory.record', 'inventory.adjust', 'payment.refund.request']),
    );
    expect(by('accountant')?.permissions).toContain('vendor.view');
  });
});

describe('limit parsing', () => {
  it('treats an absent or invalid maxDiscountPct as 0', () => {
    expect(parseRoleLimits({})).toEqual({ maxDiscountPct: 0 });
    expect(parseRoleLimits(null)).toEqual({ maxDiscountPct: 0 });
    expect(parseRoleLimits({ maxDiscountPct: 'lots' })).toEqual({ maxDiscountPct: 0 });
    expect(parseRoleLimits({ maxDiscountPct: 250 })).toEqual({ maxDiscountPct: 0 });
    expect(parseRoleLimits({ maxDiscountPct: 12.5 })).toEqual({ maxDiscountPct: 12.5 });
  });

  it('reads plan entitlements and defaults unknown ones to nothing allowed', () => {
    expect(parsePlanEntitlements({ maxVenues: 3, maxUsers: 5 })).toMatchObject({
      maxVenues: 3,
      maxSpaces: 0,
      maxUsers: 5,
    });
    expect(parsePlanEntitlements('garbage')).toMatchObject({ maxVenues: 0, customDomain: false });
  });
});

describe('manage needs view', () => {
  it('pairs <area>.manage with <area>.view only where a view permission exists', () => {
    expect(requiredViewPermission('venue.manage')).toBe('venue.view');
    expect(requiredViewPermission('customer.manage')).toBe('customer.view');
    expect(requiredViewPermission('lead.manage')).toBe('lead.view');
    expect(requiredViewPermission('vendor.manage')).toBe('vendor.view');
    expect(requiredViewPermission('catalogue.manage')).toBe('catalogue.view');
    expect(requiredViewPermission('pricing.manage')).toBe('pricing.view');
    for (const p of [
      'role.manage',
      'staff.manage',
      'billing.manage',
      'tenant.settings.manage',
      'booking.view',
    ] as const) {
      expect(requiredViewPermission(p), p).toBeNull();
    }
  });

  it('lists every manage held without its view', () => {
    expect(missingViewPermissions(['venue.manage', 'customer.manage', 'customer.view'])).toEqual([
      { manage: 'venue.manage', view: 'venue.view' },
    ]);
    expect(missingViewPermissions(['venue.manage', 'venue.view'])).toEqual([]);
    expect(missingViewPermissions([])).toEqual([]);
  });

  it('is satisfied by every default role', () => {
    for (const role of DEFAULT_ROLES) {
      expect(missingViewPermissions(role.permissions), role.name).toEqual([]);
    }
  });

  it('is enforced by the role update schema, naming the missing permission', () => {
    const bad = UpdateRoleSchema.safeParse({ rev: 1, permissions: ['venue.manage'] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('venue.view');
    expect(
      UpdateRoleSchema.safeParse({ rev: 1, permissions: ['venue.manage', 'venue.view'] }).success,
    ).toBe(true);
    expect(UpdateRoleSchema.safeParse({ rev: 1 }).success).toBe(false);
    expect(UpdateRoleSchema.safeParse({ rev: 1, active: false }).success).toBe(true);
  });
});
