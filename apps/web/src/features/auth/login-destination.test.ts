import { describe, expect, it } from 'vitest';
import { loginDestination } from './login-destination';

describe('loginDestination', () => {
  it('goes where the user wanted when a workspace is active', () => {
    expect(loginDestination({ activeTenantId: 'tnt_1' }, '/staff')).toBe('/staff');
  });

  it('asks for a workspace when none is active (several workspaces), and keeps the target', () => {
    expect(loginDestination({ activeTenantId: null }, '/staff')).toBe(
      '/select-workspace?next=%2Fstaff',
    );
  });

  it('accepting an invitation needs a login but no workspace', () => {
    expect(loginDestination({ activeTenantId: null }, '/accept-invite')).toBe('/accept-invite');
  });
});
