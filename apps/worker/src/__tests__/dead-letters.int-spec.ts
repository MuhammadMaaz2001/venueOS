import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTERS_PRESENT, DeadLetterCheckJob } from '../ops/dead-letter-check.job';
import { PgBossService } from '../queue/pg-boss.service';
import { createFixture, eventually, jobsOfQueue, startWorker } from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// Dead-letter visibility: the scheduled check logs every non-empty `*.dead` queue, and the ops script lists,
// shows, redrives and discards (docs/08 runbook). Real Postgres and pg-boss.

const SCRIPT = path.resolve(__dirname, '../../../../packages/db/scripts/dead-letters.mjs');

describe('dead letters', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  const marker = `dl-${Date.now()}`;
  const tenantId = 'tenant-dead-letters';

  const script = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MIGRATE_DATABASE_URL: process.env.VENUEOS_TEST_MIGRATOR_URL ?? '',
        ...env,
      },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const deadRow = async (entityId: string) => {
    const rows = await jobsOfQueue(fx.admin, 'pdf.render.dead', {
      key: 'entityId',
      value: entityId,
    });
    return rows[0];
  };
  const deadId = async (entityId: string) =>
    (
      await fx.admin.query<{ id: string }>(
        `SELECT id FROM pgboss.job WHERE name = 'pdf.render.dead' AND data->>'entityId' = $1`,
        [entityId],
      )
    ).rows[0]?.id;

  beforeAll(async () => {
    fx = await createFixture();
    worker = await startWorker();
    const boss = worker.get<PgBossService>(PgBossService).boss;
    // two dead letters: a kind nobody registered, and a payload that is not valid at all
    // (queue policy `short`: one queued job per singleton key, so each gets its own)
    await boss.send(
      'pdf.render',
      { tenantId, kind: 'invoice', entityId: `${marker}-a` },
      { singletonKey: `${marker}-a` },
    );
    await boss.send(
      'pdf.render',
      { tenantId, kind: 'sample', entityId: `${marker}-b`, extra: 1 },
      { singletonKey: `${marker}-b` },
    );
    for (const suffix of ['a', 'b']) {
      await eventually(async () => deadRow(`${marker}-${suffix}`), { what: 'a dead letter' });
    }
  });
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  describe('the scheduled check', () => {
    it('reports every dead-letter queue that holds jobs, with count and age', async () => {
      const job = worker.get<DeadLetterCheckJob>(DeadLetterCheckJob);
      const status = await job.check();
      const pdf = status.find((s) => s.queue === 'pdf.render.dead');
      expect(pdf?.count).toBeGreaterThanOrEqual(2);
      expect(pdf?.oldestSeconds).toBeGreaterThanOrEqual(0);
      expect(status.every((s) => s.queue.endsWith('.dead') && s.count > 0)).toBe(true);
    });

    it('logs an ERROR line the alarm can match, naming the queue and nothing from the payload', async () => {
      const boss = worker.get<PgBossService>(PgBossService).boss;
      await boss.send('ops.dead-letter-check', {});
      const line = await eventually(
        async () =>
          worker
            .logLines()
            .find((l) => l.msg === DEAD_LETTERS_PRESENT && l.queue === 'pdf.render.dead'),
        { what: 'the dead letters log line' },
      );
      expect(line).toMatchObject({ level: 50, queue: 'pdf.render.dead' });
      expect(line.count).toBeGreaterThanOrEqual(2);
      // (the lines of the failed jobs carry their tenant id, like every job line; the alarm line does not)
      const alarms = worker.logLines().filter((l) => l.msg === DEAD_LETTERS_PRESENT);
      expect(JSON.stringify(alarms)).not.toContain(tenantId);
      expect(Object.keys(line).sort()).toEqual(
        [
          'app',
          'attempt',
          'count',
          'jobId',
          'level',
          'msg',
          'oldestSeconds',
          'queue',
          'time',
        ].sort(),
      );
    });

    it('is scheduled every five minutes (registered at start by the scheduler: see scanner.int-spec)', () => {
      const job = worker.get<DeadLetterCheckJob>(DeadLetterCheckJob);
      expect(job.schedule).toEqual({ cron: '*/5 * * * *', tz: 'UTC' });
    });
  });

  describe('the ops script (runs as the migrator)', () => {
    it('list shows each dead letter with the failure code from the job that failed', async () => {
      const { code, out } = script(['list', '--queue', 'pdf.render.dead']);
      expect(code).toBe(0);
      const a = await deadId(`${marker}-a`);
      const b = await deadId(`${marker}-b`);
      expect(out).toMatch(new RegExp(`${a}\\tpdf\\.render\\.dead\\t\\d+\\tUNKNOWN_KIND\\t0`));
      expect(out).toMatch(new RegExp(`${b}\\tpdf\\.render\\.dead\\t\\d+\\tINVALID_PAYLOAD\\t0`));
    });

    it('show prints the payload (identifiers only) and the failure, never a connection string', async () => {
      const a = await deadId(`${marker}-a`);
      const { code, out, err } = script(['show', a ?? '']);
      expect(code).toBe(0);
      const shown = JSON.parse(out) as Record<string, unknown>;
      expect(shown).toMatchObject({
        queue: 'pdf.render.dead',
        originalQueue: 'pdf.render',
        failure: { code: 'UNKNOWN_KIND' },
        data: { tenantId, kind: 'invoice', entityId: `${marker}-a` },
      });
      expect(out + err).not.toContain('postgres');
    });

    it('redrive is a dry run unless --apply is given', async () => {
      const a = await deadId(`${marker}-a`);
      const { code, out } = script(['redrive', a ?? '']);
      expect(code).toBe(0);
      expect(out).toContain(`would redrive to pdf.render: ${a}`);
      expect(out).toContain('dry run: nothing changed');
      expect(await deadId(`${marker}-a`)).toBe(a);
    });

    it('redrive --apply sends a fresh job with the same payload to the original queue and removes the dead one', async () => {
      // stop the worker first, so that the redriven job stays queued for us to look at
      await worker.stop();
      const a = await deadId(`${marker}-a`);
      const { code, out } = script(['redrive', a ?? '', '--apply']);
      expect(code).toBe(0);
      expect(out).toMatch(new RegExp(`redriven ${a} -> \\S+ \\(pdf\\.render\\)`));
      expect(await deadId(`${marker}-a`)).toBeUndefined();
      const queued = await fx.admin.query<{ state: string; data: unknown; dead_letter: string }>(
        `SELECT state, data, dead_letter FROM pgboss.job
          WHERE name = 'pdf.render' AND data->>'entityId' = $1 AND state = 'created'`,
        [`${marker}-a`],
      );
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]).toMatchObject({
        data: { tenantId, kind: 'invoice', entityId: `${marker}-a` },
        // the queue's own policy applies, so a second failure lands in the dead-letter queue again
        dead_letter: 'pdf.render.dead',
      });
      await fx.admin.query(
        `DELETE FROM pgboss.job WHERE name = 'pdf.render' AND state = 'created' AND data->>'entityId' = $1`,
        [`${marker}-a`],
      );
    });

    it('discard removes a dead letter only with --apply', async () => {
      const b = await deadId(`${marker}-b`);
      expect(script(['discard', b ?? '']).out).toContain('would discard');
      expect(await deadId(`${marker}-b`)).toBe(b);
      expect(script(['discard', b ?? '', '--apply']).out).toContain(`discarded ${b}`);
      expect(await deadId(`${marker}-b`)).toBeUndefined();
    });

    it('refuses what it should: a live queue, no target, both targets, no connection', () => {
      expect(script(['list', '--queue', 'pdf.render']).code).toBe(2);
      expect(script(['redrive']).code).toBe(2);
      expect(script(['redrive', 'x', '--queue', 'pdf.render.dead']).code).toBe(2);
      expect(script(['bogus']).code).toBe(2);
      const noUrl = script(['list'], { MIGRATE_DATABASE_URL: '' });
      expect(noUrl.code).toBe(2);
      expect(noUrl.err).toContain('MIGRATE_DATABASE_URL');
    });

    it('a failure never prints the connection string', () => {
      const result = script(['list'], {
        MIGRATE_DATABASE_URL: 'postgresql://someone:hunter2-secret@127.0.0.1:1/nowhere',
      });
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain('hunter2-secret');
    });
  });
});
