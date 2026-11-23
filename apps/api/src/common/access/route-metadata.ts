import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { IS_AUTHENTICATED_ONLY_KEY, IS_PUBLIC_KEY } from './access.decorators';

/** True when the handler or its controller class is marked `@Public()`. */
export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/** True when the handler or its controller class is marked `@AuthenticatedOnly()` (login, no tenant needed). */
export function isAuthenticatedOnlyRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_AUTHENTICATED_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}
