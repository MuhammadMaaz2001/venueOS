// Integration tests for the enqueue side of the job system against a real, migrated schema:
// a job exists if and only if its transaction committed, and nothing customer-related reaches pgboss.job.
// Run: pnpm --filter @venueos/db test (needs the docker Postgres, like test:constraints)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { JobQueue, TenantDb, enqueueEmail, expectedPgBossSchemaVersion } from '../src/index.js';
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
    for (const secret of ['ali.khan', 'Ali Khan', 'Royal Hall', 'BK-1']) assert.ok(!raw.includes(secret));

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
    assert.deepEqual([row.event, row.entityType, row.entityId], ['booking.confirmed', 'booking', 'bk1']);
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

describe('JobQueue.send', () => {
  test('refuses a payload with anything but tenantId and messageKey, and inserts nothing', async () => {
    const beforeJobs = (await jobRows()).length;
    await assert.rejects(
      tenantDb.tx({ tenantId: 't1' }, (tx) =>
        queue.send(tx, 'email.send', { tenantId: 't1', messageKey: 'm1', to: 'a@b.test' } as never),
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
      fast.send(tx, 'email.send', { tenantId: 't1', messageKey: 'fast-1' }, { singletonKey: 'fast-1' }),
    );
    await fast.close();
    const job = (await jobRows()).find((j) => j.singleton_key === 'fast-1')!;
    assert.deepEqual([job.retry_limit, job.retry_delay, job.retry_backoff], [2, 1, false]);
  });
});

describe('pg-boss schema', () => {
  test('the installed library expects the schema version the migration installed', async () => {
    const { rows } = await jobsClient.query<{ version: number }>('SELECT version FROM pgboss.version');
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
    assert.deepEqual(rows, [
      {
        name: 'email.send',
        policy: 'short',
        retry_limit: 5,
        retry_delay: 30,
        retry_backoff: true,
        retry_delay_max: 3600,
        dead_letter: 'email.send.dead',
      },
      {
        name: 'email.send.dead',
        policy: 'standard',
        retry_limit: 0,
        retry_delay: 0,
        retry_backoff: false,
        retry_delay_max: null,
        dead_letter: null,
      },
    ]);
  });
});
