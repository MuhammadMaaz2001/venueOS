import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AuthDb } from '@venueos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RETENTION, AuthPurgeJob } from '../auth/auth-purge.job';
import type { AuthPurgeCounts } from '../auth/auth-purge.job';
import { createLogger } from '../logging/logging.module';
import { PgBossService } from '../queue/pg-boss.service';
import {
  createFixture,
  createTenant,
  eventually,
  jobsOfQueue,
  startWorker,
} from './helpers/harness';
import type { Fixture } from './helpers/harness';

// auth.purge against a real, migrated database, as venueos_auth (the role the job runs as).
//
// One seeded database state, one purge (in beforeAll), then one test per rule, so a failure names the rule:
//   sessions · tokens · invitations · login_attempts (30 days) · auth_requests (1 day) · unverified signups
//   (credentials and tokens only) · rows that must stay · second run deletes nothing · batches · scheduled run
//   without PII in its logs · failure path without PII · the user can get credentials again.
// The end-to-end "sign up again after the purge" test needs the API, so it lives in
// apps/api/src/__tests__/auth-signup.int-spec.ts ("an abandoned signup whose credentials auth.purge removed ...").

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe('auth.purge', () => {
  let fx: Fixture;
  let tenantId: string;
  let roleId: string;
  let firstRun: AuthPurgeCounts;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ahead = (ms: number) => new Date(now.getTime() + ms);
  const suffix = randomUUID().slice(0, 8);
  const hash = (name: string) => `${name}-${suffix}`;
  const strip = (value: string) => value.replace(`-${suffix}`, '');

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    fx = await createFixture();
    tenantId = await createTenant(fx.tenantDb);
    roleId = await fx.tenantDb.tx({ tenantId }, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: `Owner-${suffix}`, permissions: [] },
      });
      return role.id;
    });
    const db = fx.authDb.client;

    const makeUser = async (
      key: string,
      data: { verified: boolean; createdAt: Date; credentials?: boolean; token?: boolean },
    ) => {
      const user = await db.user.create({
        data: {
          email: `${key}-${suffix}@example.test`,
          name: key,
          emailVerifiedAt: data.verified ? ago(HOUR) : null,
          createdAt: data.createdAt,
        },
      });
      ids[key] = user.id;
      if (data.credentials !== false) {
        await db.userCredential.create({ data: { userId: user.id, passwordHash: 'x' } });
      }
      if (data.token) {
        await db.authToken.create({
          data: {
            userId: user.id,
            purpose: 'EMAIL_VERIFY',
            tokenHash: hash(`tok-${key}`),
            expiresAt: ahead(DAY),
          },
        });
      }
      return user.id;
    };

    // Signups that never verified: purged (40 days), just inside the window (29 days), recent, token only,
    // and one that has a session (activity); plus a verified account.
    await makeUser('abandoned', { verified: false, createdAt: ago(40 * DAY), token: true });
    await makeUser('token-only', {
      verified: false,
      createdAt: ago(40 * DAY),
      credentials: false,
      token: true,
    });
    await makeUser('almost', { verified: false, createdAt: ago(29 * DAY), token: true });
    await makeUser('recent', { verified: false, createdAt: ago(10 * DAY), token: true });
    const withSession = await makeUser('with-session', {
      verified: false,
      createdAt: ago(40 * DAY),
    });
    await makeUser('verified', { verified: true, createdAt: ago(40 * DAY) });
    const owner = ids.verified as string;

    // The abandoned signup also created a workspace: tenant side rows that must survive the purge.
    await fx.tenantDb.tx({ tenantId }, async (tx) => {
      await tx.membership.create({
        data: { tenantId, userId: ids.abandoned as string, roleId, venueIds: [] },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: ids.abandoned as string,
          action: 'tenant.signup',
          entityType: 'tenant',
          entityId: tenantId,
        },
      });
    });

    const session = (key: string, data: Record<string, Date>) =>
      db.authSession.create({
        data: {
          userId: owner,
          tokenHash: hash(`sess-${key}`),
          expiresAt: data.expiresAt ?? ahead(10 * DAY),
          lastSeenAt: data.lastSeenAt ?? now,
          ...(data.revokedAt ? { revokedAt: data.revokedAt } : {}),
        },
      });
    await session('live', {});
    await session('expired-long', { expiresAt: ago(3 * DAY) });
    await session('revoked-long', { revokedAt: ago(3 * DAY) });
    await session('idle-long', { lastSeenAt: ago(3 * DAY) });
    await session('revoked-recent', { revokedAt: ago(HOUR) });
    await session('expired-recent', { expiresAt: ago(HOUR) });
    await db.authSession.create({
      data: {
        userId: withSession,
        tokenHash: hash('sess-of-unverified'),
        expiresAt: ahead(DAY),
      },
    });

    const token = (key: string, data: { usedAt?: Date; expiresAt: Date }) =>
      db.authToken.create({
        data: {
          userId: owner,
          purpose: 'PASSWORD_RESET',
          tokenHash: hash(`t-${key}`),
          expiresAt: data.expiresAt,
          ...(data.usedAt ? { usedAt: data.usedAt } : {}),
        },
      });
    await token('live', { expiresAt: ahead(HOUR) });
    await token('used', { expiresAt: ahead(HOUR), usedAt: ago(HOUR) });
    await token('expired', { expiresAt: ago(HOUR) });

    const invitation = (key: string, data: Record<string, Date>) =>
      db.invitation.create({
        data: {
          tenantId,
          email: `${key}-${suffix}@example.test`,
          roleId,
          tokenHash: hash(`inv-${key}`),
          expiresAt: data.expiresAt ?? ahead(DAY),
          ...(data.acceptedAt ? { acceptedAt: data.acceptedAt } : {}),
          ...(data.revokedAt ? { revokedAt: data.revokedAt } : {}),
        },
      });
    await invitation('pending', {});
    await invitation('accepted-long', { acceptedAt: ago(40 * DAY), expiresAt: ago(37 * DAY) });
    await invitation('revoked-long', { revokedAt: ago(40 * DAY) });
    await invitation('expired-long', { expiresAt: ago(40 * DAY) });
    await invitation('expired-recent', { expiresAt: ago(10 * DAY) });
    await invitation('accepted-recent', { acceptedAt: ago(5 * DAY), expiresAt: ago(2 * DAY) });
    await invitation('revoked-recent', { revokedAt: ago(5 * DAY) });

    const email = `attempts-${suffix}`;
    await db.loginAttempt.createMany({
      data: [
        { emailHash: email, createdAt: ago(40 * DAY) },
        { emailHash: email, createdAt: ago(29 * DAY) },
        { emailHash: email, createdAt: ago(HOUR) },
      ],
    });
    await db.authRequest.createMany({
      data: [
        { kind: 'signup', emailHash: email, createdAt: ago(2 * DAY) },
        { kind: 'signup', emailHash: email, createdAt: ago(HOUR) },
      ],
    });

    firstRun = await new AuthPurgeJob(fx.authDb, () => now).purge(now);
  });

  afterAll(async () => {
    await fx?.close();
  });

  const remaining = async () => {
    const db = fx.authDb.client;
    const where = { tokenHash: { endsWith: suffix } };
    const names = (rows: { tokenHash: string }[]) => rows.map((r) => strip(r.tokenHash)).sort();
    return {
      sessions: names(await db.authSession.findMany({ where, select: { tokenHash: true } })),
      tokens: names(await db.authToken.findMany({ where, select: { tokenHash: true } })),
      invitations: names(await db.invitation.findMany({ where, select: { tokenHash: true } })),
      loginAttempts: await db.loginAttempt.count({ where: { emailHash: `attempts-${suffix}` } }),
      authRequests: await db.authRequest.count({ where: { emailHash: `attempts-${suffix}` } }),
    };
  };

  describe('deletion rules', () => {
    it('sessions: ended or revoked more than a day ago, or idle for more than two days, are deleted', async () => {
      const { sessions } = await remaining();
      expect(sessions).not.toContain('sess-expired-long');
      expect(sessions).not.toContain('sess-revoked-long');
      expect(sessions).not.toContain('sess-idle-long');
      expect(firstRun.sessions).toBeGreaterThanOrEqual(3);
    });

    it('tokens: used ones and expired ones are deleted, live ones stay', async () => {
      const { tokens } = await remaining();
      expect(tokens).not.toContain('t-used');
      expect(tokens).not.toContain('t-expired');
      expect(tokens).toContain('t-live');
      expect(firstRun.tokens).toBeGreaterThanOrEqual(2);
    });

    it('invitations: accepted, revoked or expired more than 30 days ago are deleted', async () => {
      const { invitations } = await remaining();
      expect(invitations).not.toContain('inv-accepted-long');
      expect(invitations).not.toContain('inv-revoked-long');
      expect(invitations).not.toContain('inv-expired-long');
      expect(firstRun.invitations).toBeGreaterThanOrEqual(3);
    });

    it('login_attempts: kept for 30 days (incident investigation), older ones are deleted', async () => {
      expect(AUTH_RETENTION.loginAttemptMs).toBe(30 * DAY);
      // the 40-day-old row went; the 29-day-old and the recent one stay
      expect((await remaining()).loginAttempts).toBe(2);
      expect(firstRun.loginAttempts).toBeGreaterThanOrEqual(1);
    });

    it('auth_requests: kept for one day, older ones are deleted', async () => {
      expect(AUTH_RETENTION.authRequestMs).toBe(DAY);
      expect((await remaining()).authRequests).toBe(1);
      expect(firstRun.authRequests).toBeGreaterThanOrEqual(1);
    });

    it('unverified signups older than 30 days with no session lose credentials and tokens, nothing else', async () => {
      const db = fx.authDb.client;
      expect(firstRun.unverifiedCredentials).toBe(2); // 'abandoned' and 'token-only'
      for (const key of ['abandoned', 'token-only']) {
        const id = ids[key] as string;
        expect(await db.userCredential.findUnique({ where: { userId: id } }), key).toBeNull();
        expect(await db.authToken.count({ where: { userId: id } }), key).toBe(0);
        // the user row stays: no runtime role may delete users
        expect(await db.user.findUnique({ where: { id } }), key).toMatchObject({
          emailVerifiedAt: null,
        });
      }
    });

    it('the workspace of an abandoned signup stays: tenant, membership and audit row are untouched', async () => {
      const abandoned = ids.abandoned as string;
      const side = await fx.tenantDb.tx({ tenantId }, async (tx) => ({
        tenant: await tx.tenant.findUnique({ where: { id: tenantId } }),
        membership: await tx.membership.count({ where: { tenantId, userId: abandoned } }),
        audit: await tx.auditLog.count({ where: { tenantId, actorUserId: abandoned } }),
      }));
      expect(side.tenant).not.toBeNull();
      expect(side.membership).toBe(1);
      expect(side.audit).toBe(1);
    });
  });

  describe('what must stay', () => {
    it('keeps live and recent rows of every kind', async () => {
      expect(await remaining()).toEqual({
        sessions: ['sess-expired-recent', 'sess-live', 'sess-of-unverified', 'sess-revoked-recent'],
        tokens: ['t-live', 'tok-almost', 'tok-recent'],
        invitations: [
          'inv-accepted-recent',
          'inv-expired-recent',
          'inv-pending',
          'inv-revoked-recent',
        ],
        loginAttempts: 2,
        authRequests: 1,
      });
    });

    it('keeps the credentials of a signup that is too recent, one day inside the window, one with a session and a verified account', async () => {
      const db = fx.authDb.client;
      for (const key of ['almost', 'recent', 'with-session', 'verified']) {
        expect(
          await db.userCredential.findUnique({ where: { userId: ids[key] as string } }),
          key,
        ).not.toBeNull();
      }
      expect(await db.authToken.count({ where: { userId: ids.almost as string } })).toBe(1);
      expect(await db.authToken.count({ where: { userId: ids.recent as string } })).toBe(1);
    });
  });

  describe('repeat runs and size', () => {
    it('is idempotent: a second run deletes nothing and changes nothing', async () => {
      const before = await remaining();
      const again = await new AuthPurgeJob(fx.authDb, () => now).purge(now);
      expect(again).toEqual({
        sessions: 0,
        tokens: 0,
        invitations: 0,
        loginAttempts: 0,
        authRequests: 0,
        unverifiedCredentials: 0,
      });
      expect(await remaining()).toEqual(before);
    });

    it('works through a backlog bigger than one batch (1000 rows per statement)', async () => {
      const emailHash = `bulk-${suffix}`;
      await fx.authDb.client.loginAttempt.createMany({
        data: Array.from({ length: 2300 }, () => ({ emailHash, createdAt: ago(45 * DAY) })),
      });
      const counts = await new AuthPurgeJob(fx.authDb, () => now).purge(now);
      expect(counts.loginAttempts).toBeGreaterThanOrEqual(2300);
      expect(await fx.authDb.client.loginAttempt.count({ where: { emailHash } })).toBe(0);
    });
  });

  describe('as a job', () => {
    it('a user left without credentials can get new ones: what a fresh signup relies on', async () => {
      const db = fx.authDb.client;
      const id = ids.abandoned as string;
      expect(await db.userCredential.findUnique({ where: { userId: id } })).toBeNull();
      // the upsert the API's signup restart does for an unverified address (auth.service restartUnverifiedSignup)
      await db.userCredential.upsert({
        where: { userId: id },
        create: { userId: id, passwordHash: 'fresh' },
        update: { passwordHash: 'fresh' },
      });
      expect(await db.userCredential.findUnique({ where: { userId: id } })).toMatchObject({
        passwordHash: 'fresh',
      });
    });

    it('runs scheduled (03:00 Asia/Karachi), purges, and logs counts only: no address, name, id or hash', async () => {
      // an abandoned signup that exists only for this run, with recognisable personal data
      const db = fx.authDb.client;
      const person = await db.user.create({
        data: {
          email: `pii-${suffix}@example.test`,
          name: `Pii Person ${suffix}`,
          createdAt: ago(60 * DAY),
        },
      });
      await db.userCredential.create({ data: { userId: person.id, passwordHash: 'x' } });
      await db.authToken.create({
        data: {
          userId: person.id,
          purpose: 'EMAIL_VERIFY',
          tokenHash: `tokpii-${suffix}`,
          expiresAt: ahead(DAY),
        },
      });

      const worker = await startWorker({ env: { SCHEDULER_ENABLED: 'true' } });
      try {
        const boss = worker.get<PgBossService>(PgBossService).boss;
        const schedule = (await boss.getSchedules('auth.purge'))[0];
        expect(schedule).toMatchObject({ cron: '0 3 * * *', timezone: 'Asia/Karachi' });

        const jobId = await boss.send('auth.purge', {});
        expect(jobId).toBeTruthy();
        await eventually(
          async () => {
            const rows = await fx.admin.query<{ state: string }>(
              'SELECT state FROM pgboss.job WHERE id = $1',
              [jobId],
            );
            return rows.rows[0]?.state === 'completed' ? true : undefined;
          },
          { what: 'auth.purge to complete' },
        );
        const line = worker.logLines().find((l) => l.msg === 'auth purge finished');
        expect(line).toMatchObject({
          queue: 'auth.purge',
          sessions: expect.any(Number),
          // the person below, and 'abandoned' again (the previous test gave it credentials back)
          unverifiedCredentials: 2,
        });
        // it really purged the person ...
        expect(await db.userCredential.findUnique({ where: { userId: person.id } })).toBeNull();
        // ... and said nothing about them
        const logs = worker.rawLogs();
        for (const secret of [suffix, '@example.test', 'Pii Person', person.id, 'tokpii']) {
          expect(logs, secret).not.toContain(secret);
        }
      } finally {
        await worker.stop();
      }
    });

    it('a failing purge is retried with a fixed code and its error text (addresses, URLs) is never logged', async () => {
      const secretText = `connection to postgres://venueos_auth:hunter2@db:5432 failed for ali.khan@example.test`;
      const broken = {
        client: {
          authSession: {
            findMany: () => Promise.reject(Object.assign(new Error(secretText), { code: 'P1001' })),
          },
        },
      } as unknown as AuthDb;
      let output = '';
      const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      });
      const result = await new AuthPurgeJob(broken).execute(
        { id: 'job-1', data: {}, retryCount: 0, retryLimit: 5 },
        createLogger('info', stream),
      );
      expect(result).toMatchObject({
        id: 'job-1',
        status: 'failed',
        output: { code: 'UNEXPECTED' },
      });
      expect(output).toContain('"errorCode":"P1001"');
      for (const secret of ['hunter2', 'ali.khan', 'postgres://', 'db:5432']) {
        expect(output, secret).not.toContain(secret);
      }
    });

    it('dead-letters a payload that is not empty (INVALID_PAYLOAD) without running', async () => {
      const worker = await startWorker();
      try {
        const boss = worker.get<PgBossService>(PgBossService).boss;
        const marker = `marker-${suffix}`;
        await boss.send('auth.purge', { userId: marker });
        const dead = await eventually(
          async () => {
            const rows = await jobsOfQueue(fx.admin, 'auth.purge.dead', {
              key: 'userId',
              value: marker,
            });
            return rows.length > 0 ? rows : undefined;
          },
          { what: 'the dead letter' },
        );
        expect(dead[0]?.data).toEqual({ userId: marker });
        // the failure code is on the job that failed (the dead-letter copy only carries the payload)
        const [failed] = await jobsOfQueue(fx.admin, 'auth.purge', {
          key: 'userId',
          value: marker,
        });
        expect(failed).toMatchObject({ state: 'failed', output: { code: 'INVALID_PAYLOAD' } });
      } finally {
        await worker.stop();
      }
    });
  });
});
