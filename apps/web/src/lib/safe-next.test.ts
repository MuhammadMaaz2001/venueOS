import { describe, expect, it } from 'vitest';
import { safeNextPath, sessionLostRedirect } from './safe-next';

describe('safeNextPath', () => {
  it('keeps a path of this app', () => {
    expect(safeNextPath('/staff')).toBe('/staff');
    expect(safeNextPath('/staff?tab=1')).toBe('/staff?tab=1');
  });

  it.each([
    '//evil.example',
    'https://evil.example',
    '/\\evil.example',
    'staff',
    '',
    null,
    undefined,
    '/a\nb',
  ])('falls back for %j', (value) => {
    expect(safeNextPath(value as string | null | undefined)).toBe('/');
  });
});

describe('sessionLostRedirect', () => {
  it('returns to where the user was, and says when the session expired', () => {
    expect(sessionLostRedirect({ pathname: '/staff', search: '' }, 'SESSION_EXPIRED')).toBe(
      '/login?next=%2Fstaff&reason=expired',
    );
    expect(sessionLostRedirect({ pathname: '/staff', search: '' }, 'UNAUTHENTICATED')).toBe(
      '/login?next=%2Fstaff',
    );
  });

  it('does not loop on the login page', () => {
    expect(sessionLostRedirect({ pathname: '/login', search: '' }, 'UNAUTHENTICATED')).toBe(
      '/login',
    );
  });
});
