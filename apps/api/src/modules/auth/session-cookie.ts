import type { CookieOptions, Request, Response } from 'express';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE_NAME } from './auth.constants';

// `__Host-` cookies must be Secure, have Path=/ and no Domain: the browser then binds them to this exact
// host and refuses to let a subdomain or an insecure page overwrite them (docs/04-security.md section 1).
// Chrome and Firefox treat http://localhost as secure, so the cookie works in local development too.
const BASE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };

/** The session token from the Cookie header; the first value when the cookie is sent more than once. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...BASE, maxAge: SESSION_ABSOLUTE_MS });
}

export function clearSessionCookie(res: Response | undefined): void {
  res?.clearCookie(SESSION_COOKIE_NAME, BASE);
}
