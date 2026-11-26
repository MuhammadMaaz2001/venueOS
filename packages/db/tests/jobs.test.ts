// Integration tests for the enqueue side of the job system against a real, migrated schema:
// a job exists if and only if its transaction committed, and nothing customer-related reaches pgboss.job.
// Run: pnpm --filter @venueos/db test (needs the docker Postgres, like test:constraints)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  JobQueue,
  SealError,
  TenantDb,
  createSealer,
  enqueueEmail,
  expectedPgBossSchemaVersion,
  openTemplateVars,
} from '../src/index.js';
import { createTestDatabase, dropTestDatabase, seedAs, urlFor } from './helpers/test-db.mjs';

let admin: pg.Client;
let dbName: string;
let tenantDb: TenantDb;
let jobsClient: pg.Client; // venueos_jobs: reads pgboss.* for assertions
let queue: JobQueue;

const input = {
  to: 'ali.khan@example.test',
  template: 'sample.hello',
  locale: 'en',
  vars: { name: 'Ali Khan', venue: 'Royal Hall', booking: { number: 'BK-1' } },
  event: 'booking.confirmed',
  entityType: 'booking',
  entityId: 'bk1',
};

const jobRows = async () =>
  (
    await jobsClient.query<{
      name: string;
      data: Record<string, unknown>;
      singleton_key: string | null;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      dead_letter: string | null;
    }>(
      `SELECT name, data, singleton_key, retry_limit, retry_delay, retry_backoff, dead_letter
         FROM pgboss.job ORDER BY created_on`,
    )
  ).rows;

before(async () => {
  ({ admin, dbName } = await createTestDatabase());
  for (const id of ['t1', 't2']) {
    await seedAs(
      'venueos_app',
      dbName,
      { tenant: id },
      `INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
         VALUES ('${id}','${id}-slug','Tenant ${id}','PK','PKR','Asia/Karachi','ACTIVE')`,
    );
  }
  tenantDb = new TenantDb({ connectionString: urlFor('venueos_app', dbName), poolMax: 5 });
  jobsClient = new pg.Client({ connectionString: urlFor('venueos_jobs', dbName) });
  await jobsClient.connect();
  queue = new JobQueue({ connectionString: urlFor('venueos_app', dbName) });
});

after(async () => {
  await queue?.close();
  await jobsClient?.end();
  await tenantDb?.close();
  await dropTestDatabase(admin, dbName);
});

describe('enqueueEmail', () => {
  test('on commit: the queued message_logs row and the job exist; the job carries only tenantId + messageKey', async () => {
    const before = (await jobRows()).length;
    const { messageKey, jobId } = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      enqueueEmail(queue, tx, 't1', input),
    );
    assert.match(jobId, /^[0-9a-f-]{36}$/);

    const jobs = await jobRows();
    assert.equal(jobs.length, before + 1);
    const job = jobs[jobs.length - 1]!;
    assert.equal(job.name, 'email.send');
    // Nothing customer-related is ever stored in pgboss.job.
    assert.deepEqual(job.data, { tenantId: 't1', messageKey });
    assert.equal(job.singleton_key, messageKey);
    assert.deepEqual(
      [job.retry_limit, job.retry_delay, job.retry_backoff, job.dead_letter],
      [5, 30, true, 'email.send.dead'],
    );
    const raw = JSON.stringify(job);
    for (const secret of ['ali.khan', 'Ali Khan', 'Royal Hall', 'BK-1'])
      assert.ok(!raw.includes(secret));

    const rows = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      tx.messageLog.findMany({ where: { messageKey } }),
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.status, 'queued');
    assert.equal(row.channel, 'email');
    assert.equal(row.to, input.to);
    assert.equal(row.template, 'sample.hello');
    assert.equal(row.locale, 'en');
    assert.deepEqual(row.templateVars, input.vars);
    assert.deepEqual(
      [row.event, row.entityType, row.entityId],
      ['booking.confirmed', 'booking', 'bk1'],
    );
    assert.equal(row.isFinal, false);
  });

  test('on rollback: no job and no message_logs row are left behind', async () => {
    const beforeJobs = (await jobRows()).length;
    let key = '';
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, async (tx) => {
        const queued = await enqueueEmail(queue, tx, 't1', input);
        key = queued.messageKey;
        // The job is visible inside the transaction...
        const inside = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pgboss.job`;
        assert.equal(Number(inside[0]!.n), beforeJobs + 1);
        throw new Error('business rule failed');
      }),
      /business rule failed/,
    );
    // ...and gone after the rollback.
    assert.equal((await jobRows()).length, beforeJobs);
    const rows = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      tx.messageLog.findMany({ where: { messageKey: key } }),
    );
    assert.deepEqual(rows, []);
  });

  test('a message of another tenant cannot be written (RLS), and then no job exists either', async () => {
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) => enqueueEmail(queue, tx, 't2', input)),
      /row-level security/i,
    );
    assert.equal((await jobRows()).length, beforeJobs);
  });

  test('validates the input before writing anything', async () => {
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        enqueueEmail(queue, tx, 't1', { ...input, to: 'not-an-address' }),
      ),
    );
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        enqueueEmail(queue, tx, 't1', { ...input, vars: { a: null } as never }),
      ),
    );
    assert.equal((await jobRows()).length, beforeJobs);
  });

  test('another tenant cannot read the queued row', async () => {
    const { messageKey } = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      enqueueEmail(queue, tx, 't1', input),
    );
    const seen = await tenantDb.tx({ tenantId: 't2' }, (tx) =>
      tx.messageLog.count({ where: { messageKey } }),
    );
    assert.equal(seen, 0);
  });
});

describe('queues of the worker jobs (migration worker_queues_p0_6b)', () => {
  const queueRows = async () =>
    (
      await jobsClient.query<{
        name: string;
        policy: string;
        dead_letter: string | null;
        retry_limit: number;
      }>('SELECT name, policy, dead_letter, retry_limit FROM pgboss.queue ORDER BY name')
    ).rows;

  test('every job has its queue and a dead-letter queue that is never retried', async () => {
    const queues = new Map((await queueRows()).map((q) => [q.name, q]));
    for (const name of ['email.send', 'pdf.render', 'auth.purge', 'ops.dead-letter-check']) {
      assert.equal(queues.get(name)?.dead_letter, `${name}.dead`, name);
      assert.equal(queues.get(name)?.policy, 'short', name);
      assert.equal(queues.get(`${name}.dead`)?.retry_limit, 0, `${name}.dead`);
    }
  });

  test('pdf.render is enqueued with identifiers only, in the caller transaction, with the dead-letter queue', async () => {
    const payload = { tenantId: 't1', kind: 'sample', entityId: 'ent-1' };
    const before = (await jobRows()).length;
    const id = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      queue.send(tx, 'pdf.render', payload, { singletonKey: 'sample:ent-1' }),
    );
    assert.ok(id);
    const job = (await jobRows()).find((j) => j.name === 'pdf.render');
    assert.deepEqual(job?.data, payload);
    assert.equal(job?.dead_letter, 'pdf.render.dead');
    assert.equal((await jobRows()).length, before + 1);

    // an extra key (customer data riding along) is refused before anything is written
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        queue.send(tx, 'pdf.render', { ...payload, customerName: 'Ali Khan' } as never, {
          singletonKey: 'sample:ent-3',
        }),
      ),
    );
    // so is a rollback: no job survives it
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, async (tx) => {
        await queue.send(
          tx,
          'pdf.render',
          { ...payload, entityId: 'ent-2' },
          { singletonKey: 'sample:ent-2' },
        );
        throw new Error('rolled back');
      }),
      /rolled back/,
    );
    assert.equal((await jobRows()).length, before + 1);
  });
});

describe('enqueueEmail with secret variables', () => {
  const sealer = createSealer({
    active: 'k1',
    keys: { k1: Buffer.alloc(32, 7).toString('base64') },
  });
  const secret = 'https://app.example.test/verify-email?token=SECRET-TOKEN-123';

  test('stores them sealed (never in plain text) and opens them only for the same row', async () => {
    const { messageKey } = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      enqueueEmail(queue, tx, 't1', { ...input, secretVars: { verifyUrl: secret } }, { sealer }),
    );
    const [row] = await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      tx.messageLog.findMany({ where: { messageKey } }),
    );
    const stored = row?.templateVars as Record<string, unknown>;
    assert.equal(stored.name, 'Ali Khan'); // plain variables stay plain
    assert.equal(typeof stored.__sealed, 'string');
    assert.ok(!JSON.stringify(row).includes('SECRET-TOKEN-123'));
    assert.ok(!JSON.stringify(await jobRows()).includes('SECRET-TOKEN-123'));

    assert.deepEqual(openTemplateVars(sealer, 't1', messageKey, stored).verifyUrl, secret);
    // A sealed blob moved to another message or tenant does not open.
    assert.throws(() => openTemplateVars(sealer, 't1', 'another-message', stored), SealError);
    assert.throws(() => openTemplateVars(sealer, 't2', messageKey, stored), SealError);
  });

  test('refuses secret variables without a sealer, and a reserved variable name, before writing anything', async () => {
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        enqueueEmail(queue, tx, 't1', { ...input, secretVars: { verifyUrl: secret } }),
      ),
      /need a sealer/,
    );
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        enqueueEmail(queue, tx, 't1', { ...input, vars: { __sealed: 'forged' } }, { sealer }),
      ),
    );
    assert.equal((await jobRows()).length, beforeJobs);
  });
});

describe('JobQueue.send', () => {
  test('the singleton key is required: leaving it out is a type error, an empty one is refused', async () => {
    const payload = { tenantId: 't1', messageKey: 'no-key-1' };
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        // @ts-expect-error singletonKey is mandatory: a keyless job would silently drop the next one
        queue.send(tx, 'email.send', payload),
      ),
      /singletonKey/,
    );
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        queue.send(tx, 'email.send', payload, { singletonKey: '' }),
      ),
      /singletonKey/,
    );
    assert.equal((await jobRows()).length, beforeJobs);
  });

  test('refuses a payload with anything but tenantId and messageKey, and inserts nothing', async () => {
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        queue.send(
          tx,
          'email.send',
          { tenantId: 't1', messageKey: 'm1', to: 'a@b.test' } as never,
          {
            singletonKey: 'm1',
          },
        ),
      ),
    );
    assert.equal((await jobRows()).length, beforeJobs);
  });

  test('a second send with the same singleton key while one is queued returns null (idempotent enqueue)', async () => {
    const beforeJobs = (await jobRows()).length;
    const [first, second] = await tenantDb.tx({ tenantId: 't1' }, async (tx) => {
      const payload = { tenantId: 't1', messageKey: 'dedupe-1' };
      return [
        await queue.send(tx, 'email.send', payload, { singletonKey: 'dedupe-1' }),
        await queue.send(tx, 'email.send', payload, { singletonKey: 'dedupe-1' }),
      ];
    });
    assert.ok(first);
    assert.equal(second, null);
    assert.equal((await jobRows()).length, beforeJobs + 1);
  });

  test('the retry policy can be shortened for tests and is stored on the job', async () => {
    const fast = new JobQueue({
      connectionString: urlFor('venueos_app', dbName),
      retry: { retryDelaySeconds: 1, retryDelayMaxSeconds: 1, retryBackoff: false, retryLimit: 2 },
    });
    await tenantDb.tx({ tenantId: 't1' }, (tx) =>
      fast.send(
        tx,
        'email.send',
        { tenantId: 't1', messageKey: 'fast-1' },
        { singletonKey: 'fast-1' },
      ),
    );
    await fast.close();
    const job = (await jobRows()).find((j) => j.singleton_key === 'fast-1')!;
    assert.deepEqual([job.retry_limit, job.retry_delay, job.retry_backoff], [2, 1, false]);
  });
});

describe('pg-boss schema', () => {
  test('the installed library expects the schema version the migration installed', async () => {
    const { rows } = await jobsClient.query<{ version: number }>(
      'SELECT version FROM pgboss.version',
    );
    assert.deepEqual(
      rows.map((r) => r.version),
      [expectedPgBossSchemaVersion()],
      'pg-boss was upgraded without a new migration (see packages/db/scripts/pgboss-sql.mjs)',
    );
  });

  test('the queues exist with the documented policy', async () => {
    const { rows } = await jobsClient.query<{
      name: string;
      policy: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      retry_delay_max: number | null;
      dead_letter: string | null;
    }>(
      `SELECT name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, dead_letter
         FROM pgboss.queue ORDER BY name`,
    );
    const dead = (name: string) => ({
      name,
      policy: 'standard',
      retry_limit: 0,
      retry_delay: 0,
      retry_backoff: false,
      retry_delay_max: null,
      dead_letter: null,
    });
    const live = (name: string, retryLimit: number, delayMax: number) => ({
      name,
      policy: 'short',
      retry_limit: retryLimit,
      retry_delay: 30,
      retry_backoff: true,
      retry_delay_max: delayMax,
      dead_letter: `${name}.dead`,
    });
    // email.send (P0-6a), then pdf.render, auth.purge and ops.dead-letter-check (P0-6b), then the lead follow-up
    // scanner and its per-lead job (module 5), then the hold scanner, the completion scanner and their per-booking
    // jobs (modules 6-8)
    assert.deepEqual(rows, [
      live('auth.purge', 5, 3600),
      dead('auth.purge.dead'),
      live('bookings.complete', 5, 3600),
      dead('bookings.complete.dead'),
      live('bookings.complete.run', 5, 3600),
      dead('bookings.complete.run.dead'),
      live('email.send', 5, 3600),
      dead('email.send.dead'),
      live('holds.expire', 5, 3600),
      dead('holds.expire.dead'),
      live('holds.expire.run', 5, 3600),
      dead('holds.expire.run.dead'),
      live('holds.warn.run', 5, 3600),
      dead('holds.warn.run.dead'),
      live('leads.follow-up', 5, 3600),
      dead('leads.follow-up.dead'),
      live('leads.follow-up.notify', 5, 3600),
      dead('leads.follow-up.notify.dead'),
      live('ops.dead-letter-check', 2, 300),
      dead('ops.dead-letter-check.dead'),
      live('pdf.render', 5, 3600),
      dead('pdf.render.dead'),
    ]);
  });
});
