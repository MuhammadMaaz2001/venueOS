import type { Permission, RoleLimits } from '@venueos/shared';

/**
 * Who the caller is, as established by authentication (P0-4). Guards read it from CLS; they never
 * look at cookies or headers themselves.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** The tenant the session is currently working in; null before one is chosen. */
  activeTenantId: string | null;
}

/** What the caller may do in the active tenant, filled by TenantGuard (docs/02, request lifecycle). */
export interface TenantAccess {
  tenantId: string;
  membershipId: string;
  roleId: string;
  roleName: string;
  /** Known permission names of the role. Re-read on every request: a role edit applies at once. */
  permissions: readonly Permission[];
  /** Empty = all venues of the tenant. */
  venueIds: readonly string[];
  limits: RoleLimits;
}
