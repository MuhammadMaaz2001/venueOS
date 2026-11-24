import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Scanner } from '../scanners/scanner';
import type { ScanContext, ScanTarget } from '../scanners/scanner';
import { ScanQueryError, ScannerDb } from '../scanners/scanner-db';
import type { ExtraJobDeps, Fixture, RunningWorker } from './helpers/harness';
import { PgBossService } from '../queue/pg-boss.service';
import { createFixture, createTenant, eventually, startWorker } from './helpers/harness';

// Scanner infrastructure: a test-only scanner finds tenants with the venueos_jobs connection (ids only) and
// enqueues one job per tenant; scheduling is registered from the job's `schedule`.

const PROBE_TARGET: ScanTarget<{ tenantId: string }> = {
  queue: 'probe.tenant',
  payloadSchema: z.object({ tenantId: z.string() }).strict(),
  expireInSeconds: 60,
};

/** Walks `tenants` in pages of two and enqueues `probe.tenant` for each of them. */
class TenantProbeScanner extends Scanner {
  readonly queue = 'scan.probe';
  override readonly schedule = { cron: '*/10 * * * *', tz: 'UTC' };
  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages('SELECT id FROM tenants', [], { pageSize: 2 })) {
      for (const row of page) {
        await ctx.enqueue(PROBE_TARGET, { tenantId: row.id }, `probe:${row.id}`);
      }
    }
  }
}

/** Selects a column it must not read. */
class GreedyScanner extends Scanner {
  readonly queue = 'scan.greedy';
  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages('SELECT id, name FROM tenants')) void page;
  }
}

/** Tries to put customer data into a job payload. */
class LeakyScanner extends Scanner {
  readonly queue = 'scan.leaky';
  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages('SELECT id FROM tenants')) {
      for (const row of page) {
        await ctx.enqueue(
          PROBE_TARGET,
          { tenantId: row.id, name: 'Royal Hall' } as never,
          `leak:${row.id}`,
        );
      }
    }
  }
}

describe('scanners', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  let boss: PgBossService['boss'];
  const tenantIds: string[] = [];

  const probeJobs = async () => {
    const { rows } = await fx.admin.query<{ tenant_id: string; singleton_key: string }>(
      `SELECT data->>'tenantId' AS tenant_id, singleton_key FROM pgboss.job
        WHERE name = 'probe.tenant' AND data->>'tenantId' = ANY($1)`,
      [tenantIds],
    );
    return rows;
  };
  const scanState = async (jobId: string | null) => {
    const { rows } = await fx.admin.query<{ state: string; output: { code?: string } | null }>(
      'SELECT state, output FROM pgboss.job WHERE id = $1',
      [jobId],
    );
    return rows[0];
  };
  const runScan = async (queue: string) => {
    const jobId = await boss.send(queue, {});
    return eventually(
      async () => {
        const row = await scanState(jobId);
        return row && ['completed', 'failed'].includes(row.state) ? row : undefined;
      },
      { what: `${queue} to finish` },
    );
  };

  beforeAll(async () => {
    fx = await createFixture();
    // The queues of the test jobs are created like production queues: by the migrator.
    for (const name of [
      'probe.tenant.dead',
      'probe.tenant',
      'scan.probe',
      'scan.greedy',
      'scan.leaky',
    ]) {
      await fx.admin.query(
        `SELECT pgboss.create_queue($1, '{"policy":"short","retryLimit":0}'::jsonb)`,
        [name],
      );
    }
    for (let i = 0; i < 5; i++) tenantIds.push(await createTenant(fx.tenantDb, `Scan ${i}`));
    worker = await startWorker({
      env: { SCHEDULER_ENABLED: 'true' },
      extraJobs: ({ scannerDb, pgBoss }: ExtraJobDeps) => [
        new TenantProbeScanner(scannerDb, pgBoss),
        new GreedyScanner(scannerDb, pgBoss),
        new LeakyScanner(scannerDb, pgBoss),
      ],
    });
    boss = worker.get<PgBossService>(PgBossService).boss;
  });
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  it('finds tenants across pages and enqueues exactly one identifier-only job per tenant', async () => {
    const run = await runScan('scan.probe');
    expect(run.state).toBe('completed');
    const jobs = await probeJobs();
    expect(jobs.map((j) => j.tenant_id).sort()).toEqual([...tenantIds].sort());
    expect(jobs.every((j) => j.singleton_key === `probe:${j.tenant_id}`)).toBe(true);
    const data = await fx.admin.query<{ data: object }>(
      `SELECT data FROM pgboss.job WHERE name = 'probe.tenant' AND data->>'tenantId' = $1`,
      [tenantIds[0]],
    );
    expect(data.rows[0]?.data).toEqual({ tenantId: tenantIds[0] });
  });

  it('is idempotent: scanning again queues nothing twice', async () => {
    await runScan('scan.probe');
    expect(await probeJobs()).toHaveLength(tenantIds.length);
    const line = worker
      .logLines()
      .filter((l) => l.msg === 'scan finished')
      .at(-1);
    expect(line).toMatchObject({ enqueued: 0, queue: 'scan.probe' });
    expect(line?.alreadyQueued).toBeGreaterThanOrEqual(tenantIds.length);
  });

  it('registers the scanner schedule with its cron and time zone', async () => {
    const [schedule] = await boss.getSchedules('scan.probe');
    expect(schedule).toMatchObject({ cron: '*/10 * * * *', timezone: 'UTC' });
    const names = (await boss.getSchedules()).map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['scan.probe', 'auth.purge', 'ops.dead-letter-check']),
    );
  });

  it('refuses a query that reads anything but ids, before a value leaves the scanner connection', async () => {
    const scannerDb = worker.get<ScannerDb>(ScannerDb);
    const read = async (sql: string) => {
      for await (const page of scannerDb.pages(sql)) void page;
    };
    await expect(read('SELECT id, name FROM tenants')).rejects.toBeInstanceOf(ScanQueryError);
    await expect(read(`SELECT 'has space' AS id`)).rejects.toBeInstanceOf(ScanQueryError);
    await expect(read('SELECT id FROM tenants; DROP TABLE tenants')).rejects.toBeInstanceOf(
      ScanQueryError,
    );
    const run = await runScan('scan.greedy');
    expect(run.state).not.toBe('completed');
  });

  it('cannot read tenant data beyond its grants (venueos_jobs is not BYPASSRLS for nothing)', async () => {
    const scannerDb = worker.get<ScannerDb>(ScannerDb);
    const read = async () => {
      for await (const page of scannerDb.pages('SELECT id FROM customers')) void page;
    };
    // customers is not one of the seven scanner tables: permission denied, not an empty result
    await expect(read()).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a payload with anything but identifiers before it reaches the queue', async () => {
    const run = await runScan('scan.leaky');
    expect(run.state).not.toBe('completed');
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM pgboss.job WHERE name = 'probe.tenant' AND data ? 'name'`,
    );
    expect(rows).toHaveLength(0);
  });
});
