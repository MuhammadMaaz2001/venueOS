import type { Permission } from '@venueos/shared';
import type { TenantAccess } from './access-context';
import { ForbiddenError } from '../errors/domain-errors';

/**
 * Privilege-escalation guard (docs/04-security.md section 2): holding `role.manage` or `staff.manage` does
 * not let a caller grant anything they lack. Permissions already granted may stay; new ones must be held by
 * the caller, and the discount limit may not rise above the caller's own.
 *
 * Shared by role editing and staff management (assigning a role, inviting).
 */
export function assertNoEscalation(
  access: TenantAccess,
  nextPermissions: readonly Permission[],
  currentPermissions: readonly Permission[],
  nextMaxDiscount: number,
  currentMaxDiscount: number,
): void {
  const notHeld = nextPermissions.filter(
    (p) => !currentPermissions.includes(p) && !access.permissions.includes(p),
  );
  if (notHeld.length > 0) {
    throw new ForbiddenError('You cannot grant permissions you do not have yourself.');
  }
  if (nextMaxDiscount > currentMaxDiscount && nextMaxDiscount > access.limits.maxDiscountPct) {
    throw new ForbiddenError('You cannot grant a higher discount limit than your own.');
  }
}
