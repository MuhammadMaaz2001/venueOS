import { SetMetadata } from '@nestjs/common';
import type { EntitlementResource, Permission } from '@venueos/shared';

// Metadata read by AuthGuard / TenantGuard / PermissionGuard / EntitlementGuard and by the route-scan
// test (`__tests__/route-scan.spec.ts`), which fails when a route declares neither of the first two.
export const IS_PUBLIC_KEY = 'venueos:isPublic';
export const PERMISSION_KEY = 'venueos:permission';
export const ENTITLEMENT_KEY = 'venueos:entitlement';

/** Marks an endpoint that needs no session. Every use is reviewed (CLAUDE.md rule 2). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the single permission a staff endpoint needs. Names come from
 * packages/shared/src/permissions.ts (mirrors docs/04-security.md); anything else is a type error.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Marks a create endpoint that consumes a plan limit (`plans.entitlements`). EntitlementGuard answers
 * 402 PLAN_LIMIT_REACHED when the tenant is already at the limit. It is a guard-level check; a service
 * that must be strict re-checks inside its own transaction.
 */
export const Entitlement = (resource: EntitlementResource): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTITLEMENT_KEY, resource);
