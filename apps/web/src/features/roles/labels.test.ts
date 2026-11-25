import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_GROUPS } from '@venueos/shared';
import type { Permission } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import {
  PERMISSION_GROUP_LIST,
  isRequiredByManage,
  permissionKey,
  systemRoleKey,
  togglePermission,
} from './labels';

const permissionLabels = en.Permissions as Record<string, string>;
const groupLabels = en.Roles.groups as Record<string, string>;
const systemLabels = en.Roles.system as Record<string, string>;

describe('permission labels', () => {
  it('every permission has a human label, and there are no labels for unknown permissions', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionLabels[permissionKey(permission)], permission).toBeTruthy();
      // A label is words, not the raw permission name.
      expect(permissionLabels[permissionKey(permission)], permission).not.toBe(permission);
    }
    expect(Object.keys(permissionLabels).sort()).toEqual(PERMISSIONS.map(permissionKey).sort());
  });

  it('keys are unique and contain no dots (next-intl would read them as nesting)', () => {
    const keys = PERMISSIONS.map(permissionKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).not.toContain('.');
  });

  it('every permission group has a label and the editor lists every permission once', () => {
    expect(Object.keys(groupLabels).sort()).toEqual(Object.keys(PERMISSION_GROUPS).sort());
    for (const { group } of PERMISSION_GROUP_LIST) expect(groupLabels[group], group).toBeTruthy();
    expect(PERMISSION_GROUP_LIST.flatMap((g) => g.permissions).sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
  });

  it('every system role has a display name, and its English name equals the stored one', () => {
    for (const role of DEFAULT_ROLES) {
      expect(systemRoleKey(role.name)).toBe(role.key);
      expect(systemLabels[role.key], role.key).toBe(role.name);
    }
    expect(systemRoleKey('Front desk')).toBeNull();
  });
});

describe('togglePermission', () => {
  const set = (...p: Permission[]) => new Set<Permission>(p);

  it('ticking manage also ticks view', () => {
    expect([...togglePermission(set(), 'venue.manage', true)].sort()).toEqual([
      'venue.manage',
      'venue.view',
    ]);
    expect([...togglePermission(set(), 'role.manage', true)]).toEqual(['role.manage']);
  });

  it('a view needed by a ticked manage cannot be unticked, but can once manage is gone', () => {
    const held = set('venue.manage', 'venue.view');
    expect(isRequiredByManage(held, 'venue.view')).toBe(true);
    expect(togglePermission(held, 'venue.view', false)).toEqual(held);
    const withoutManage = togglePermission(held, 'venue.manage', false);
    expect([...withoutManage]).toEqual(['venue.view']);
    expect([...togglePermission(withoutManage, 'venue.view', false)]).toEqual([]);
  });

  it('does not change the set it was given', () => {
    const held = set('customer.view');
    togglePermission(held, 'customer.manage', true);
    expect([...held]).toEqual(['customer.view']);
  });
});
