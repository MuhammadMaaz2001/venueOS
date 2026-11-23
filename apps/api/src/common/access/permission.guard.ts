import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { RequestContext } from '../context/request-context';
import { ForbiddenError, UnauthenticatedError } from '../errors/domain-errors';
import { PERMISSION_KEY } from './access.decorators';
import { isPublicRoute } from './route-metadata';

/**
 * Step 5 of the request lifecycle (docs/02): the handler's `@RequirePermission()` must be in the
 * caller's role. A non-public route that declares no permission is denied (the route-scan test should
 * make that impossible; this is the runtime backstop).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PermissionGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    if (isPublicRoute(this.reflector, context)) return true;

    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      this.logger.error(
        { handler: `${context.getClass().name}.${context.getHandler().name}` },
        'Route declares neither @Public() nor @RequirePermission(); denying',
      );
      throw new ForbiddenError();
    }

    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    if (!access.permissions.includes(required)) throw new ForbiddenError();
    return true;
  }
}
