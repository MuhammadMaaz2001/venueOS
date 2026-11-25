import { DEFAULT_ROLES, PERMISSION_GROUPS, requiredViewPermission } from '@venueos/shared';
import type { Permission } from '@venueos/shared';

/** Key in `Permissions.*` of a permission: dots are not allowed in message keys (`booking.confirm` -> `booking_confirm`). */
export const permissionKey = (permission: Permission): string => permission.replaceAll('.', '_');

/** The permission groups of `docs/04-security.md` section 2, in order, for the role editor. */
export const PERMISSION_GROUP_LIST: readonly {
  group: string;
  permissions: readonly Permission[];
}[] = Object.entries(PERMISSION_GROUPS).map(([group, permissions]) => ({
  group,
  permissions: permissions as readonly Permission[],
}));

/** Key of a system role in `Roles.system.*` (`Branch manager` -> `branch_manager`), or null for a custom role. */
export function systemRoleKey(name: string): string | null {
  return DEFAULT_ROLES.find((role) => role.name === name)?.key ?? null;
}

/**
 * Tick or untick a permission. Ticking `<area>.manage` also ticks `<area>.view` (the API refuses one without the
 * other); a `view` that a ticked `manage` needs cannot be unticked.
 */
export function togglePermission(
  current: ReadonlySet<Permission>,
  permission: Permission,
  on: boolean,
): Set<Permission> {
  const next = new Set(current);
  if (on) {
    next.add(permission);
    const view = requiredViewPermission(permission);
    if (view) next.add(view);
  } else if (!isRequiredByManage(next, permission)) {
    next.delete(permission);
  }
  return next;
}

/** True when `permission` is the `view` of an area whose `manage` is ticked: it must stay ticked. */
export function isRequiredByManage(
  current: ReadonlySet<Permission>,
  permission: Permission,
): boolean {
  if (!permission.endsWith('.view')) return false;
  for (const held of current) {
    if (requiredViewPermission(held) === permission) return true;
  }
  return false;
}
