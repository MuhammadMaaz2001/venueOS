/**
 * Where to go after logging in. Only a path of this app is accepted: `//evil.example`, `https://...`,
 * `/\evil` and anything else that could leave the origin fall back to the dashboard (open-redirect defence).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  // A control character or a backslash anywhere can be used to confuse URL parsers.
  for (const char of next) {
    if (char === '\\' || char.charCodeAt(0) < 0x20) return fallback;
  }
  return next;
}

/** `/login?next=<where the user was>[&reason=expired]` after the session was lost. */
export function sessionLostRedirect(
  location: Pick<Location, 'pathname' | 'search'>,
  code: string,
): string {
  const params = new URLSearchParams();
  const here = `${location.pathname}${location.search}`;
  if (!location.pathname.startsWith('/login')) params.set('next', safeNextPath(here));
  if (code === 'SESSION_EXPIRED') params.set('reason', 'expired');
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
