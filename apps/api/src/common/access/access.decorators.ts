import { SetMetadata } from '@nestjs/common';

// Metadata only. Enforcement (AuthGuard, TenantGuard, PermissionGuard and the route-scan test that
// every handler declares one of the two) arrives in P0-4 / P0-5; until then nothing reads these keys.
export const IS_PUBLIC_KEY = 'venueos:isPublic';
export const PERMISSION_KEY = 'venueos:permission';

/** Marks an endpoint that needs no session. Every use is reviewed (CLAUDE.md rule 2). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the permission a staff endpoint needs. Names come from packages/shared/src/permissions.ts
 * (mirrors docs/04-security.md); the parameter is narrowed to that union in P0-5 when the file exists.
 */
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, permission);
