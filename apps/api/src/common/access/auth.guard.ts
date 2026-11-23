import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import { UnauthenticatedError } from '../errors/domain-errors';
import { AuthContextProvider } from './auth-context.provider';
import { isPublicRoute } from './route-metadata';

/**
 * Step 3 of the request lifecycle (docs/02): ask the AuthContextProvider who is calling and store the
 * answer in CLS. It knows nothing about cookies or sessions: P0-4 supplies the provider that does.
 * Public routes skip it. No identity -> 401.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly provider: AuthContextProvider,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) return true;

    const auth = await this.provider.resolve(context.switchToHttp().getRequest<Request>());
    if (!auth) throw new UnauthenticatedError();

    this.cls.set('auth', auth);
    this.cls.set('userId', auth.userId);
    return true;
  }
}
