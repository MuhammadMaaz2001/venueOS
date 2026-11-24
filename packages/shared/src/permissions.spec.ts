import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PermissionSchema, isPermission } from './permissions.js';
import {
  DEFAULT_ROLES,
  OWNER_REQUIRED_PERMISSIONS,
  parsePlanEntitlements,
  parseRoleLimits,
} from './roles.js';

describe('permissions', () => {
  it('has 44 unique names of the form area.action', () => {
    expect(PERMISSIONS).toHaveLength(44);
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
