import type { ClsStore } from 'nestjs-cls';
import type { AuthContext, TenantAccess } from '../access/access-context';

/**
 * Per-request context kept in CLS (nestjs-cls). Services never read `req`; they read this.
 *
 * Who fills what, in guard order (docs/02-system-design.md, request lifecycle):
 *  - `requestId`, `ip`: the CLS middleware.
 *  - `auth`, `userId`: AuthGuard, from the AuthContextProvider (P0-4 provides the real one).
 *  - `tenantId`, `access`: TenantGuard, after checking the membership.
 */
export interface RequestContext extends ClsStore {
  requestId: string;
  /** Client address after `trust proxy` (audit rows). */
  ip?: string;
  auth?: AuthContext;
  userId?: string;
  tenantId?: string;
  access?: TenantAccess;
}
