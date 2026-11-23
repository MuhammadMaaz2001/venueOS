import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEmail } from '@venueos/db';
import { EmailProviderError } from '../email/email-provider';
import type { EmailProvider, OutgoingEmail } from '../email/email-provider';
import {
  createFixture,
  createTenant,
  eventually,
  jobsFor,
  messageLog,
  startWorker,
  uniqueRecipient,
} from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// Failure handling with a scripted provider: retries with backoff, then the dead-letter queue; permanent
// failures (invalid payload, unknown template) dead-letter at once. Real Postgres and pg-boss.

class ScriptedProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  calls: OutgoingEmail[] = [];
  constructor(private readonly fail: () => unknown) {}
  send(message: OutgoingEmail): Promise<{ providerRef: string }> {
    this.calls.push(message);
    const error = this.fail();
    return error ? Promise.reject(error) : Promise.resolve({ providerRef: 'scripted-1' });
  }
}

const SECRET_TEXT = 'smtp login failed for ali.khan@example.test password=hunter2';
const base = { template: 'sample.hello', locale: 'en', event: 'booking.confirmed' };
const goodVars = { name: 'Ali', venue: 'Hall', booking: { number: 'BK-9' } };
const unavailable = () => new EmailProviderError('PROVIDER_UNAVAILABLE');

describe('email.send failures', () => {
  // Fast retries: up to 5 retries one second apart (the production policy is 30 s backoff, capped at 1 h).
  let fx: Fixture;
  let tenantId: string;

  beforeAll(async () => {
    fx = await createFixture({ retryDelaySeconds: 1, retryBackoff: false });
    tenantId = await createTenant(fx.tenantDb);
  });
  afterAll(async () => {
    await fx?.close();
  });

  // One worker at a time, so that the scripted provider is the only one that can pick up a job.
  async function withWorker<T>(
    provider: EmailProvider,
    fn: (worker: RunningWorker) => Promise<T>,
  ): Promise<T> {
    const worker = await startWorker({ provider });
    try {
      return await fn(worker);
    } finally {
      await worker.stop();
    }
  }

  const enqueue = (extra: Record<string, unknown>) =>
    fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, {
        ...base,
        to: uniqueRecipient(),
        vars: goodVars,
        ...extra,
      }),
    );

  const finalRow = (messageKey: string, what: string) =>
    eventually(
      async () => {
        const r = await messageLog(fx.admin, tenantId, messageKey);
        return r.some((x) => x.is_final) ? r : undefined;
      },
      { timeoutMs: 60_000, what },
    );

  const deadLettered = (messageKey: string) =>
    eventually(
      async () => {
        const j = await jobsFor(fx.admin, messageKey);
        return j.some((x) => x.name === 'email.send.dead') ? j : undefined;
      },
      { what: 'the dead-letter job' },
    );

  it('a failing provider is retried 5 times, then the job is dead-lettered; every attempt is logged', async () => {
    const provider = new ScriptedProvider(unavailable);
    const { messageKey } = await withWorker(provider, async () => {
      const queued = await enqueue({});
      await finalRow(queued.messageKey, 'the final failed row');
      return queued;
    });

    // 1 attempt + 5 retries
    expect(provider.calls).toHaveLength(6);
    const rows = await messageLog(fx.admin, tenantId, messageKey);
    expect(rows.map((r) => r.status)).toEqual(['queued', ...Array(6).fill('failed')]);
    expect(rows.slice(1).map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.slice(1).map((r) => r.is_final)).toEqual([false, false, false, false, false, true]);
    expect(new Set(rows.slice(1).map((r) => r.error))).toEqual(new Set(['PROVIDER_UNAVAILABLE']));

    const jobs = await deadLettered(messageKey);
    expect(jobs.find((j) => j.name === 'email.send')).toMatchObject({
      state: 'failed',
      retry_count: 5,
    });
    expect(jobs.find((j) => j.name === 'email.send.dead')?.data).toEqual({ tenantId, messageKey });
  });

  it('an unexpected provider error is retried too, and its raw text is stored nowhere', async () => {
    const provider = new ScriptedProvider(() => new Error(SECRET_TEXT));
    await withWorker(provider, async (worker) => {
      const { messageKey } = await enqueue({});
      await finalRow(messageKey, 'the final failed row');
      const rows = await messageLog(fx.admin, tenantId, messageKey);
      expect(new Set(rows.slice(1).map((r) => r.error))).toEqual(new Set(['UNEXPECTED']));

      const everything =
        JSON.stringify([rows, await jobsFor(fx.admin, messageKey)]) + worker.rawLogs();
      expect(everything).not.toContain('hunter2');
      expect(everything).not.toContain('ali.khan@example.test');
    });
  });

  it('recovers: a provider that fails once is retried and the message ends up sent', async () => {
    let failures = 1;
    const flaky = new ScriptedProvider(() => (failures-- > 0 ? unavailable() : null));
    await withWorker(flaky, async () => {
      const { messageKey } = await enqueue({});
      const rows = await eventually(
        async () => {
          const r = await messageLog(fx.admin, tenantId, messageKey);
          return r.some((x) => x.status === 'sent') ? r : undefined;
        },
        { what: 'the sent row' },
      );
      expect(rows.map((r) => [r.status, r.attempt])).toEqual([
        ['queued', null],
        ['failed', 1],
        ['sent', 2],
      ]);
    });
  });

  it('an unknown template is a permanent failure: one final failed row, dead-lettered at once, provider never called', async () => {
    const provider = new ScriptedProvider(() => null);
    await withWorker(provider, async () => {
      const { messageKey } = await enqueue({ template: 'no.such.template' });
      const jobs = await deadLettered(messageKey);
      const rows = await messageLog(fx.admin, tenantId, messageKey);
      expect(rows.map((r) => [r.status, r.error, r.attempt, r.is_final])).toEqual([
        ['queued', null, null, false],
        ['failed', 'UNKNOWN_TEMPLATE', 1, true],
      ]);
      expect(jobs.find((j) => j.name === 'email.send')).toMatchObject({
        state: 'failed',
        retry_count: 0,
        output: { code: 'UNKNOWN_TEMPLATE' },
      });
      expect(provider.calls).toHaveLength(0);
    });
  });

  it('variables that do not fit the template are permanent too (INVALID_PAYLOAD), without retries', async () => {
    await withWorker(new ScriptedProvider(() => null), async () => {
      const { messageKey } = await enqueue({ vars: { name: 'Ali' } });
      const jobs = await deadLettered(messageKey);
      const rows = await messageLog(fx.admin, tenantId, messageKey);
      expect(rows[1]).toMatchObject({
        status: 'failed',
        error: 'INVALID_PAYLOAD',
        attempt: 1,
        is_final: true,
      });
      expect(jobs.find((j) => j.name === 'email.send')?.retry_count).toBe(0);
    });
  });

  it('a sealed secret that does not open for its row (copied or tampered) is permanent (INVALID_PAYLOAD)', async () => {
    const link = 'https://app.example.test/reset-password?token=TAMPER-TEST-TOKEN-0123456789';
    const sealed = (to: string) =>
      fx.tenantDb.tx({ tenantId }, (tx) =>
        enqueueEmail(
          fx.queue,
          tx,
          tenantId,
          {
            ...base,
            template: 'auth.password-reset',
            to,
            vars: { name: 'Ali', minutes: 30 },
            secretVars: { resetUrl: link },
          },
          { sealer: fx.sealer },
        ),
      );
    const toFirst = uniqueRecipient();
    const toSecond = uniqueRecipient();
    const first = await sealed(toFirst);
    const second = await sealed(toSecond);

    // Copy the first row's sealed blob onto the second row (the migrator owns the table; RLS still applies).
    await fx.admin.query('BEGIN');
    try {
      await fx.admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await fx.admin.query(
        `UPDATE message_logs SET template_vars = jsonb_set(template_vars, '{__sealed}', (
           SELECT template_vars->'__sealed' FROM message_logs WHERE message_key = $1 AND status = 'queued')
         ) WHERE message_key = $2 AND status = 'queued'`,
        [first.messageKey, second.messageKey],
      );
      await fx.admin.query('COMMIT');
    } catch (error) {
      await fx.admin.query('ROLLBACK');
      throw error;
    }

    const provider = new ScriptedProvider(() => null);
    await withWorker(provider, async () => {
      const jobs = await deadLettered(second.messageKey);
      const rows = await messageLog(fx.admin, tenantId, second.messageKey);
      expect(rows.at(-1)).toMatchObject({
        status: 'failed',
        error: 'INVALID_PAYLOAD',
        is_final: true,
      });
      expect(jobs.find((j) => j.name === 'email.send')?.retry_count).toBe(0);
      // The untouched first row still sends.
      await eventually(
        async () =>
          (await messageLog(fx.admin, tenantId, first.messageKey)).some((r) => r.status === 'sent'),
        {
          what: 'the untouched message to be sent',
        },
      );
    });
    expect(provider.calls.map((c) => c.to)).toContain(toFirst);
    expect(provider.calls.map((c) => c.to)).not.toContain(toSecond);
  });

  it('a job payload that fails validation is dead-lettered at once and the final failed row is written', async () => {
    const messageKey = `bad-${uniqueRecipient().slice(6, 14)}`;
    await withWorker(new ScriptedProvider(() => null), async () => {
      // Not possible through the API (the payload is validated there); inject it the way a bug or a manual insert would.
      await fx.admin.query(
        `INSERT INTO pgboss.job (name, data, retry_limit, retry_delay, retry_backoff, singleton_key, dead_letter)
         VALUES ('email.send', $1::jsonb, 5, 1, false, $2, 'email.send.dead')`,
        [JSON.stringify({ tenantId, messageKey, to: 'leak@example.test' }), messageKey],
      );
      const jobs = await deadLettered(messageKey);
      const rows = await messageLog(fx.admin, tenantId, messageKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        error: 'INVALID_PAYLOAD',
        attempt: 1,
        is_final: true,
        to: 'unknown',
      });
      expect(jobs.find((j) => j.name === 'email.send')).toMatchObject({
        state: 'failed',
        retry_count: 0,
      });
    });
  });

  it('a job whose payload names no tenant is dead-lettered without a row (there is no RLS scope to write it in)', async () => {
    const messageKey = `notenant-${uniqueRecipient().slice(6, 14)}`;
    await withWorker(new ScriptedProvider(() => null), async (worker) => {
      await fx.admin.query(
        `INSERT INTO pgboss.job (name, data, retry_limit, retry_delay, retry_backoff, singleton_key, dead_letter)
         VALUES ('email.send', $1::jsonb, 5, 1, false, $2, 'email.send.dead')`,
        [JSON.stringify({ messageKey }), messageKey],
      );
      const jobs = await deadLettered(messageKey);
      expect(jobs.find((j) => j.name === 'email.send')).toMatchObject({
        state: 'failed',
        retry_count: 0,
      });
      expect(
        worker
          .logLines()
          .some(
            (l) =>
              l.code === 'INVALID_PAYLOAD' && l.tenantId === null && typeof l.jobId === 'string',
          ),
      ).toBe(true);
    });
  });

  it('a valid payload that points at no queued message is permanent (INVALID_PAYLOAD)', async () => {
    const messageKey = `orphan-${uniqueRecipient().slice(6, 14)}`;
    await withWorker(new ScriptedProvider(() => null), async () => {
      await fx.tenantDb.tx({ tenantId }, (tx) =>
        fx.queue.send(tx, 'email.send', { tenantId, messageKey }, { singletonKey: messageKey }),
      );
      const jobs = await deadLettered(messageKey);
      const rows = await messageLog(fx.admin, tenantId, messageKey);
      expect(rows[0]).toMatchObject({ status: 'failed', error: 'INVALID_PAYLOAD', is_final: true });
      expect(jobs.find((j) => j.name === 'email.send')?.retry_count).toBe(0);
    });
  });
});
