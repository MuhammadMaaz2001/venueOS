import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEmail } from '@venueos/db';
import {
  createFixture,
  createTenant,
  eventually,
  jobsFor,
  mailpitMessagesTo,
  messageLog,
  startWorker,
  uniqueRecipient,
} from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// The real worker (pg-boss as venueos_jobs, handlers as venueos_app) delivering through the real SMTP
// provider into Mailpit. Needs the docker Postgres and Mailpit (docker compose up -d postgres mailpit).

describe('email.send, delivered through SMTP into Mailpit', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  let tenantId: string;

  beforeAll(async () => {
    fx = await createFixture();
    tenantId = await createTenant(fx.tenantDb, 'Royal <Hall> "Banquet"');
    worker = await startWorker();
  });
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  const input = (to: string, vars: Record<string, unknown> = {}) => ({
    to,
    template: 'sample.hello',
    locale: 'en',
    vars: { name: 'Ali Khan', venue: 'Royal Hall', booking: { number: 'BK-2027-0001' }, ...vars },
    replyTo: 'owner@royal.example.test',
    event: 'booking.confirmed',
    entityType: 'booking',
    entityId: 'bk1',
  });

  it('an email enqueued in a committed transaction arrives in Mailpit and is logged queued -> sent', async () => {
    const to = uniqueRecipient();
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, input(to)),
    );

    const [mail] = await eventually(
      async () => {
        const found = await mailpitMessagesTo(to);
        return found.length > 0 ? found : undefined;
      },
      { what: 'the email in Mailpit' },
    ).then((m) => m);
    expect(mail?.Subject).toBe('Hello Ali Khan, your booking BK-2027-0001');
    expect(mail?.Text).toContain('Your booking BK-2027-0001 at Royal Hall is confirmed.');
    expect(mail?.HTML).toContain('<strong>BK-2027-0001</strong>');
    expect(mail?.From.Address).toBe('bookings@venueos.test');
    expect(mail?.From.Name).toBe('Royal Hall Banquet'); // tenant name, sanitized for the header
    expect(mail?.ReplyTo.map((r) => r.Address)).toEqual(['owner@royal.example.test']);

    const rows = await eventually(
      async () => {
        const r = await messageLog(fx.admin, tenantId, messageKey);
        return r.some((x) => x.status === 'sent') ? r : undefined;
      },
      { what: 'the sent row' },
    );
    expect(rows.map((r) => r.status)).toEqual(['queued', 'sent']);
    expect(rows[0]).toMatchObject({ template: 'sample.hello', attempt: null, is_final: false });
    expect(rows[1]).toMatchObject({ error: null, attempt: 1, is_final: false });
    expect(rows[1]?.provider_ref).toBeTruthy();

    const jobs = await eventually(
      async () => {
        const j = await jobsFor(fx.admin, messageKey);
        return j[0]?.state === 'completed' ? j : undefined;
      },
      { what: 'the job to complete' },
    );
    expect(jobs.map((j) => j.name)).toEqual(['email.send']);
    expect(jobs[0]?.data).toEqual({ tenantId, messageKey });
  });

  it('a rolled-back transaction leaves no job and no email', async () => {
    const to = uniqueRecipient();
    const jobCount = async () =>
      Number(
        (await fx.admin.query<{ n: string }>('SELECT count(*) AS n FROM pgboss.job')).rows[0]?.n,
      );
    const before = await jobCount();

    await expect(
      fx.tenantDb.tx({ tenantId }, async (tx) => {
        await enqueueEmail(fx.queue, tx, tenantId, input(to));
        throw new Error('booking failed');
      }),
    ).rejects.toThrow('booking failed');

    // Give the worker several polling rounds to (wrongly) pick something up.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await jobCount()).toBe(before);
    expect(await mailpitMessagesTo(to)).toEqual([]);
  });

  it('delivers an account mail whose link is a sealed secret, under the product name', async () => {
    const to = uniqueRecipient();
    const link = 'https://app.example.test/verify-email?token=SEALED-LINK-TOKEN-0123456789';
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(
        fx.queue,
        tx,
        tenantId,
        {
          to,
          template: 'auth.verify-email',
          locale: 'ur',
          vars: { name: 'Ali', hours: 24 },
          secretVars: { verifyUrl: link },
        },
        { sealer: fx.sealer },
      ),
    );
    const [mail] = await eventually(
      async () => {
        const found = await mailpitMessagesTo(to);
        return found.length > 0 ? found : undefined;
      },
      { what: 'the email in Mailpit' },
    );
    expect(mail?.Text).toContain(link);
    expect(mail?.HTML).toContain(
      'href="https://app.example.test/verify-email?token=SEALED-LINK-TOKEN-0123456789"',
    );
    expect(mail?.HTML).toContain('dir="rtl"');
    expect(mail?.From.Name).toBe('venueOS'); // not the tenant's name
    expect(mail?.From.Name).not.toContain('Royal');

    // The token was never stored or logged in plain text.
    const { rows } = await fx.admin
      .query<{ n: string }>(
        `SELECT count(*) AS n FROM (
         SELECT data::text AS t FROM pgboss.job WHERE data->>'messageKey' = $1
         UNION ALL SELECT row_to_json(m)::text FROM message_logs m WHERE message_key = $1) x
        WHERE t LIKE '%SEALED-LINK-TOKEN%'`,
        [messageKey],
      )
      .catch(() => ({ rows: [{ n: '0' }] }));
    expect(Number(rows[0]?.n)).toBe(0);
    expect(worker.rawLogs()).not.toContain('SEALED-LINK-TOKEN');
  });

  it('escapes variables: markup in a customer name never reaches the HTML as markup', async () => {
    const to = uniqueRecipient();
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(
        fx.queue,
        tx,
        tenantId,
        input(to, { name: '<img src=x onerror=alert(1)>\r\nBcc: evil@example.test' }),
      ),
    );
    const [mail] = await eventually(
      async () => {
        const found = await mailpitMessagesTo(to);
        return found.length > 0 ? found : undefined;
      },
      { what: 'the email in Mailpit' },
    );
    expect(mail?.HTML).not.toContain('<img');
    expect(mail?.HTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail?.Subject).not.toMatch(/[\r\n]/);
  });

  it('does not send twice when the same message is delivered to the worker again', async () => {
    const to = uniqueRecipient();
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, input(to)),
    );
    await eventually(async () => (await mailpitMessagesTo(to)).length === 1, {
      what: 'the first delivery',
    });
    await eventually(async () => (await jobsFor(fx.admin, messageKey))[0]?.state === 'completed', {
      what: 'the job to complete',
    });

    // The queue gives the worker the same message again (a redelivery after a crash, a manual redrive).
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      fx.queue.send(
        tx,
        'email.send',
        { tenantId, messageKey },
        { singletonKey: `${messageKey}:again` },
      ),
    );
    await eventually(
      async () => (await jobsFor(fx.admin, messageKey)).every((j) => j.state === 'completed'),
      {
        what: 'the second job to complete',
      },
    );
    expect(await mailpitMessagesTo(to)).toHaveLength(1);
    expect((await messageLog(fx.admin, tenantId, messageKey)).map((r) => r.status)).toEqual([
      'queued',
      'sent',
    ]);
  });

  it('logs jobId and tenantId on every job line, and never an address, subject or body', async () => {
    const to = uniqueRecipient();
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, input(to)),
    );
    await eventually(async () => (await messageLog(fx.admin, tenantId, messageKey)).length === 2, {
      what: 'the email to be sent',
    });

    const jobLines = worker
      .logLines()
      .filter((l) => l.queue === 'email.send' && l.msg !== 'job registered');
    expect(jobLines.length).toBeGreaterThan(0);
    for (const line of jobLines) {
      expect(line.jobId, JSON.stringify(line)).toEqual(expect.any(String));
      expect(line.tenantId).toBe(tenantId);
    }
    const raw = worker.rawLogs();
    expect(raw).not.toContain(to);
    expect(raw).not.toContain('Ali Khan');
    expect(raw).not.toContain('BK-2027-0001');
    expect(raw).not.toContain('is confirmed');
    expect(raw).not.toContain('owner@royal.example.test');
    expect(raw).toContain('g***@example.test'); // the masked form is what operators see
  });
});
