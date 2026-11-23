import { Injectable } from '@nestjs/common';
import { AuthDb } from '@venueos/db';
import type { AuthContext } from '../../common/access/access-context';
import { SessionExpiredError } from '../../common/errors/domain-errors';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  hashToken,
  newToken,
} from './auth.constants';

export interface NewSession {
  /** The raw token for the cookie. Only its hash is stored. */
  token: string;
  sessionId: string;
}

/**
 * Server-side sessions (docs/04-security.md section 1). The cookie holds 32 random bytes; `auth_sessions`
 * stores their SHA-256 hash, so a database leak does not yield usable sessions.
 *
 * Lifetime: 12 h idle (measured from `last_seen_at`, which slides at most once a minute) and 30 days
 * absolute (`expires_at`, set at login and never extended). The token is rotated at login and on tenant
 * switch. Revocation is a timestamp, never a delete (the audit trail of a session stays).
 */
@Injectable()
export class SessionService {
  constructor(private readonly authDb: AuthDb) {}

  async create(params: {
    userId: string;
    activeTenantId: string | null;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<NewSession> {
    const token = newToken();
    const row = await this.authDb.client.authSession.create({
      data: {
        userId: params.userId,
        tokenHash: hashToken(token),
        activeTenantId: params.activeTenantId,
        ip: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 256) ?? null,
        expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_MS),
      },
      select: { id: true },
    });
    return { token, sessionId: row.id };
  }

  /**
   * Who a token belongs to. `undefined` for an unknown or revoked token (the caller answers 401
   * UNAUTHENTICATED, saying nothing more); throws SessionExpiredError (401 SESSION_EXPIRED) when the idle or
   * the absolute limit has passed.
   */
  async resolve(token: string): Promise<AuthContext | undefined> {
    const row = await this.authDb.client.authSession.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row || row.revokedAt) return undefined;

    const now = Date.now();
    if (row.expiresAt.getTime() <= now || row.lastSeenAt.getTime() + SESSION_IDLE_MS <= now) {
      throw new SessionExpiredError();
    }
    if (now - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      const touched = await this.authDb.client.authSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { lastSeenAt: new Date(now) },
      });
      if (touched.count !== 1) return undefined; // revoked in the meantime
    }
    return { userId: row.userId, sessionId: row.id, activeTenantId: row.activeTenantId };
  }

  /**
   * Replace the token of a live session (tenant switch): the old token stops working at once, the row id
   * stays. Returns the new raw token, or undefined when the session is no longer live.
   */
  async rotate(sessionId: string, activeTenantId: string | null): Promise<string | undefined> {
    const token = newToken();
    const changed = await this.authDb.client.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { tokenHash: hashToken(token), activeTenantId, lastSeenAt: new Date() },
    });
    return changed.count === 1 ? token : undefined;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.authDb.client.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke every live session of a user, optionally keeping one (password change keeps the current). */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.authDb.client.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
