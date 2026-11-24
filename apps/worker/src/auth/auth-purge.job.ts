import type { AuthDb } from '@venueos/db';
import { JOB_NAMES } from '@venueos/shared';
import { z } from 'zod';
import type { ScheduleSpec } from '../jobs/registered-job';
import { SystemJob } from '../jobs/system-job';
import type { SystemJobContext } from '../jobs/system-job';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What `auth.purge` keeps (docs/09 "Handoff from P0-4", docs/04 section 12). Everything older is deleted.
 * Windows are generous on purpose: the limits that read these tables look back at most an hour, and a
 * session that ended a moment ago should still answer "your session expired" rather than a bare 401.
 */
export const AUTH_RETENTION = {
  /** Sessions: kept this long after they expired (absolute limit) or were revoked. */
  sessionAfterEndMs: DAY_MS,
  /**
   * Sessions that were simply abandoned: not seen for this long. The idle limit is 12 h
   * (docs/04 section 1); 2 days is far beyond it, so a purged session was dead long before.
   */
  sessionIdleMs: 2 * DAY_MS,
  /** Invitations: kept this long after they were accepted, revoked or expired. */
  invitationAfterEndMs: 30 * DAY_MS,
  /** `login_attempts`: kept for incident investigation (docs/04 section 12). The limits only need 15 min. */
  loginAttemptMs: 30 * DAY_MS,
  /** `auth_requests`: the abuse limits look back one hour. */
  authRequestMs: DAY_MS,
  /** A signup that never verified its email: after this long its password hash and tokens go. */
  unverifiedSignupMs: 30 * DAY_MS,
} as const;

/** Rows deleted per statement, so a big backlog never holds a long lock. */
const BATCH = 1000;
/** Safety stop per table: 1000 batches = one million rows in one run. */
const MAX_BATCHES = 1000;

export interface AuthPurgeCounts {
  sessions: number;
  tokens: number;
  invitations: number;
  loginAttempts: number;
  authRequests: number;
  /** Users whose credentials (and tokens) were removed because the signup was never verified. */
  unverifiedCredentials: number;
}

/**
 * `auth.purge`: daily cleanup of the auth tables. The ONLY worker code that uses `AuthDb`
 * (role `venueos_auth`, apps/worker/CLAUDE.md). It owns no tenant data and takes no payload.
 *
 * Abandoned unverified signups: only `user_credentials` and `auth_tokens` are deleted. The `users` row, the
 * tenant it created, the roles and the audit rows stay: `users` has no DELETE for any runtime role and
 * `audit_logs` (append-only) references it. Releasing the tenant and its slug belongs to the tenant
 * offboarding purge (docs/09 follow-ups). A new signup for the same address restarts the account.
 *
 * Idempotent: every statement deletes rows by a time condition; running it twice deletes nothing the first
 * run did not. Logs counts only, never ids, emails or hashes.
 */
export class AuthPurgeJob extends SystemJob {
  readonly queue = JOB_NAMES.AUTH_PURGE;
  /** 03:00 in Karachi, the quietest hour for the first customers (docs/09 P0-6b plan). */
  override readonly schedule: ScheduleSpec = { cron: '0 3 * * *', tz: 'Asia/Karachi' };
  protected readonly payloadSchema = z.object({}).strict();

  constructor(
    private readonly authDb: AuthDb,
    /** The clock; tests move it. */
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  protected async handle(ctx: SystemJobContext<Record<string, never>>): Promise<void> {
    const counts = await this.purge(this.now());
    ctx.log.info(counts, 'auth purge finished');
  }

  /** Delete everything past its retention as of `now`. Exposed for tests. */
  async purge(now: Date): Promise<AuthPurgeCounts> {
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const db = this.authDb.client;

    const sessions = await deleteInBatches(
      () =>
        db.authSession.findMany({
          where: {
            OR: [
              { expiresAt: { lt: ago(AUTH_RETENTION.sessionAfterEndMs) } },
              { revokedAt: { lt: ago(AUTH_RETENTION.sessionAfterEndMs) } },
              { lastSeenAt: { lt: ago(AUTH_RETENTION.sessionIdleMs) } },
            ],
          },
          select: { id: true },
          take: BATCH,
        }),
      (ids) => db.authSession.deleteMany({ where: { id: { in: ids } } }),
    );

    // Used, or past their expiry (24 h verification, 30 min reset): an unknown token is refused exactly like
    // a used one.
    const tokens = await deleteInBatches(
      () =>
        db.authToken.findMany({
          where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }] },
          select: { id: true },
          take: BATCH,
        }),
      (ids) => db.authToken.deleteMany({ where: { id: { in: ids } } }),
    );

    const invitationCutoff = ago(AUTH_RETENTION.invitationAfterEndMs);
    const invitations = await deleteInBatches(
      () =>
        db.invitation.findMany({
          where: {
            OR: [
              { acceptedAt: { lt: invitationCutoff } },
              { revokedAt: { lt: invitationCutoff } },
              { expiresAt: { lt: invitationCutoff } },
            ],
          },
          select: { id: true },
          take: BATCH,
        }),
      (ids) => db.invitation.deleteMany({ where: { id: { in: ids } } }),
    );

    const loginAttempts = await deleteInBatches(
      () =>
        db.loginAttempt.findMany({
          where: { createdAt: { lt: ago(AUTH_RETENTION.loginAttemptMs) } },
          select: { id: true },
          take: BATCH,
        }),
      (ids) => db.loginAttempt.deleteMany({ where: { id: { in: ids } } }),
    );

    const authRequests = await deleteInBatches(
      () =>
        db.authRequest.findMany({
          where: { createdAt: { lt: ago(AUTH_RETENTION.authRequestMs) } },
          select: { id: true },
          take: BATCH,
        }),
      (ids) => db.authRequest.deleteMany({ where: { id: { in: ids } } }),
    );

    // Never verified, no session, older than the retention, and still holding a password hash or a token.
    // The condition stops matching once those are gone, so the loop ends and a rerun finds nothing.
    let unverifiedCredentials = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const users = await db.user.findMany({
        where: {
          emailVerifiedAt: null,
          createdAt: { lt: ago(AUTH_RETENTION.unverifiedSignupMs) },
          authSessions: { none: {} },
          OR: [{ credentials: { isNot: null } }, { authTokens: { some: {} } }],
        },
        select: { id: true },
        take: BATCH,
      });
      if (users.length === 0) break;
      const userIds = users.map((u) => u.id);
      await this.authDb.tx(async (tx) => {
        await tx.authToken.deleteMany({ where: { userId: { in: userIds } } });
        await tx.userCredential.deleteMany({ where: { userId: { in: userIds } } });
      });
      unverifiedCredentials += userIds.length;
      if (users.length < BATCH) break;
    }

    return { sessions, tokens, invitations, loginAttempts, authRequests, unverifiedCredentials };
  }
}

/** Find a batch of ids, delete them, repeat until a batch comes back short. Returns how many rows went. */
async function deleteInBatches(
  find: () => Promise<{ id: string }[]>,
  remove: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await find();
    if (rows.length === 0) break;
    const { count } = await remove(rows.map((r) => r.id));
    total += count;
    if (rows.length < BATCH) break;
  }
  return total;
}
