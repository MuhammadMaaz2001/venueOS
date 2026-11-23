import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { CsrfRejectedError } from '../errors/domain-errors';
import { isBearerAuthenticated } from './auth-kind';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER_VALUE = 'venueos';

/**
 * CSRF defence for the cookie-authenticated web app (docs/04-security.md section 5). A state-changing
 * request must send `X-Requested-With: venueos` (a custom header cannot be added by a cross-site
 * form and needs a CORS preflight, which the API never grants) and an `Origin` equal to APP_ORIGIN.
 *
 * Every method except GET/HEAD/OPTIONS is checked, not only POST/PATCH/DELETE, so a future PUT
 * cannot be forgotten. Requests that authenticate with an `Authorization: Bearer` token instead of
 * a cookie are exempt, because a browser never attaches such a header on its own; that exemption is
 * decided by `isBearerAuthenticated` and is switched off until bearer auth exists (see auth-kind.ts).
 *
 * Registered before the auth guards so a forged request is rejected before any session is loaded.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CsrfGuard.name);
    this.allowedOrigin = config.APP_ORIGIN;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (isBearerAuthenticated(req)) return true;

    const reason = this.rejectionReason(req);
    if (reason === undefined) return true;

    // The reason goes to the log only; the response does not tell an attacker which check failed.
    this.logger.warn({ reason, method: req.method, path: req.path }, 'CSRF check failed');
    throw new CsrfRejectedError();
  }

  private rejectionReason(req: Request): string | undefined {
    if (req.header('x-requested-with') !== CSRF_HEADER_VALUE)
      return 'missing or wrong X-Requested-With';
    const origin = req.header('origin');
    // Browsers always send Origin on state-changing requests, so a missing one is rejected too.
    if (origin === undefined) return 'missing Origin';
    if (origin !== this.allowedOrigin) return 'Origin not allowed';
    return undefined;
  }
}
