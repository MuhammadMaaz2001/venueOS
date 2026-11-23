import type { ClsStore } from 'nestjs-cls';

/**
 * Per-request context kept in CLS (nestjs-cls). Services never read `req`; they read this.
 * P0-4 (AuthGuard) sets `userId`, P0-5 (TenantGuard) sets `tenantId` and the rest of
 * `{ membershipId, permissions, venueIds, limits }` (docs/02-system-design.md, request lifecycle).
 */
export interface RequestContext extends ClsStore {
  requestId: string;
  tenantId?: string;
  userId?: string;
}
