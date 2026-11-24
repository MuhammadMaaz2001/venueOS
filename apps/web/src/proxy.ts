import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/safe-next';

/** The session cookie of the API (docs/04-security.md section 1). Only its presence is checked here. */
const SESSION_COOKIE = '__Host-vos_session';

/** Pages that work without a login (the ones the emails link to, and the entry forms). */
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/forgot-password',
  '/verify-email',
  '/reset-password',
  '/accept-invite',
]);

/**
 * Content Security Policy with a nonce per request (docs/04-security.md section 5): no inline script runs unless
 * it carries the nonce, `frame-ancestors 'none'`, and the page may only talk to its own origin (the API is
 * reached through the `/api` rewrite). Inline STYLES stay allowed: the toaster and Radix inject `<style>` tags and
 * style attributes at run time, and a nonce on styles would break them; styles cannot run code (the rule of the
 * docs is "no unsafe-inline scripts"). Development needs `unsafe-eval` (React's debugging) and the HMR socket;
 * production gets neither. HTTPS itself is enforced by HSTS (next.config.ts) and the load balancer.
 */
function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'${dev ? ' ws://localhost:* http://localhost:*' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/**
 * A first, cheap gate: a visitor with no session cookie never sees an app page, they go to the login page and
 * come back afterwards. It does NOT prove the session is valid (only the API can): an expired or revoked cookie
 * passes here and the first API call answers 401, which the client turns into the same redirect.
 * It also sets the Content Security Policy of every page.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce);

  const { pathname, search } = request.nextUrl;
  if (!PUBLIC_PATHS.has(pathname) && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', safeNextPath(`${pathname}${search}`));
    const redirect = NextResponse.redirect(login);
    redirect.headers.set('Content-Security-Policy', policy);
    return redirect;
  }

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything except the API rewrite, Next's own files and static assets.
      source: '/((?!api/|_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
