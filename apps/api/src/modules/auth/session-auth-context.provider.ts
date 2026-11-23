import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../../common/access/access-context';
import { AuthContextProvider } from '../../common/access/auth-context.provider';
import { SessionExpiredError } from '../../common/errors/domain-errors';
import { clearSessionCookie, readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';

/**
 * The application's answer to "who is calling?": the `__Host-vos_session` cookie, hashed and looked up in
 * `auth_sessions` through AuthDb. Nothing else decides identity: not a header, not the body, not a query
 * string. No cookie, an unknown or a revoked token: `undefined` (AuthGuard answers 401 UNAUTHENTICATED).
 * An expired session: 401 SESSION_EXPIRED, and the dead cookie is cleared.
 */
@Injectable()
export class SessionAuthContextProvider extends AuthContextProvider {
  constructor(private readonly sessions: SessionService) {
    super();
  }

  async resolve(req: Request): Promise<AuthContext | undefined> {
    const token = readSessionCookie(req);
    if (!token) return undefined;
    try {
      return await this.sessions.resolve(token);
    } catch (error) {
      if (error instanceof SessionExpiredError) clearSessionCookie(req.res);
      throw error;
    }
  }
}
