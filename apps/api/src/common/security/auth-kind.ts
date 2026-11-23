import type { Request } from 'express';

/**
 * CSRF only threatens requests that a browser authenticates by itself, i.e. with cookies. A request
 * that carries its credentials explicitly in `Authorization: Bearer <token>` (the future mobile app
 * and public API on api.venueos.app) cannot be forged cross-site, so it is exempt from the CSRF guard.
 * Unauthenticated requests (login, signup) are NOT exempt: login CSRF is a real attack.
 *
 * TODO(P0-4): implement this when bearer-token authentication exists. Requirements:
 *   1. Return true only for a *validated* token, never just because the header is present.
 *   2. Never exempt a request that also carries the session cookie (the cookie would authenticate it).
 *   3. Decide where it runs relative to AuthGuard (CsrfGuard currently runs before it).
 * Until then it returns false: there is no bearer auth, so nothing is exempt and every
 * state-changing request is checked.
 */
export function isBearerAuthenticated(req: Request): boolean {
  void req;
  return false;
}
