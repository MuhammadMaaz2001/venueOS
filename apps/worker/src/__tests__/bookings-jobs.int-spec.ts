import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { enqueueEmail } from '@venueos/db';
import { JOB_NAMES, pdfObjectKey } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBossService } from '../queue/pg-boss.service';
import {
  MAILPIT_API,
  createFixture,
  createTenant,
  ensureTestBucket,
  eventually,
  jobsOfQueue,
  mailpitMessagesTo,
  startWorker,
  testS3,
  uniqueRecipient,
} from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// Modules 6-8 in the worker: holds.expire frees the slot and emails the agent, the "hold ending" warning is sent once and does
// not bump the booking's rev, finished bookings complete when paid, the quotation PDF renders from its frozen snapshot, and an
// email with an attachment arrives in Mailpit with the file.

const HOUR = 3_600_000;
const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

describe('booking jobs', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  let boss: PgBossService['boss'];
  let tenantId: string;
  let agent: { id: string; name: string; email: string };
  let venueId: string;
  let customerId: string;
  let spaceId: string;

  beforeAll(async () => {
    fx = await createFixture();
    await ensureTestBucket();
    tenantId = await createTenant(fx.tenantDb, 'Royal Hall');
    venueId = uid('ven');
    customerId = uid('cus');
    spaceId = uid('spc');
    agent = { id: uid('usr'), name: 'Sara Agent', email: uniqueRecipient() };
    await fx.tenantDb.asUser(agent.id, (tx) =>
      tx.user.create({
        data: { id: agent.id, name: agent.name, email: agent.email, emailVerifiedAt: new Date() },
      }),
    );
    await fx.tenantDb.tx({ tenantId, userId: agent.id }, async (tx) => {
      await tx.venue.create({ data: { id: venueId, tenantId, name: 'Main Hall', photoKeys: [] } });
      await tx.customer.create({
        data: {
          id: customerId,
          tenantId,
          name: 'Hina <Malik>',
          phone: '+923001234567',
          email: 'hina@example.test',
        },
      });
      await tx.space.create({ data: { id: spaceId, tenantId, venueId, name: 'Hall A' } });
      const roleId = uid('rol');
      await tx.role.create({
        data: { id: roleId, tenantId, name: 'Agent', permissions: ['booking.view'], limits: {} },
      });
      await tx.membership.create({
        data: { id: uid('mem'), tenantId, userId: agent.id, roleId, venueIds: [] },
      });
    });
    worker = await startWorker();
    boss = worker.get<PgBossService>(PgBossService).boss;
  }, 60_000);
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  /** A held booking with one session and its calendar block. */
  async function booking(options: {
    status?: 'TENTATIVE' | 'CONFIRMED';
    holdExpiresAt?: Date | null;
    sessionEnds?: Date;
    grandTotal?: string;
    createdById?: string | null;
  }) {
    const id = uid('bk');
    const sessionId = uid('ses');
    const status = options.status ?? 'TENTATIVE';
    const ownSpace = uid('spc'); // one space per booking: two sessions in one space would overlap
    const ends = options.sessionEnds ?? new Date(Date.now() + 10 * 24 * HOUR);
    await fx.tenantDb.tx({ tenantId }, async (tx) => {
      await tx.space.create({
        data: { id: ownSpace, tenantId, venueId, name: `Hall ${ownSpace.slice(-4)}` },
      });
      await tx.booking.create({
        data: {
          id,
          tenantId,
          venueId,
          customerId,
          status,
          currency: 'PKR',
          quoteVersion: 1,
          number: `BK-2027-${id.slice(-4)}`,
          holdExpiresAt:
            options.holdExpiresAt === undefined
              ? new Date(Date.now() - HOUR)
              : options.holdExpiresAt,
          grandTotal: options.grandTotal ?? '100000',
          createdById: options.createdById === undefined ? agent.id : options.createdById,
        },
      });
      await tx.bookingSession.create({
        data: {
          id: sessionId,
          tenantId,
          bookingId: id,
          spaceId: ownSpace,
          startsAt: new Date(ends.getTime() - 4 * HOUR),
          endsAt: ends,
          guests: 100,
        },
      });
      await tx.spaceOccupancy.create({
        data: {
          tenantId,
          sessionId,
          spaceId: ownSpace,
          startsAt: new Date(ends.getTime() - 4 * HOUR),
          endsAt: ends,
        },
      });
    });
    return { id, sessionId };
  }
  const row = (id: string) =>
    fx.tenantDb.tx({ tenantId }, (tx) => tx.booking.findFirstOrThrow({ where: { id } }));
  const occupancyActive = (sessionId: string) =>
    fx.tenantDb.tx(
      { tenantId },
      async (tx) => (await tx.spaceOccupancy.findFirstOrThrow({ where: { sessionId } })).active,
    );

  const runScan = async (queue: string) => {
    const jobId = await boss.send(queue, {});
    await eventually(
      async () => {
        const { rows } = await fx.admin.query<{ state: string }>(
          'SELECT state FROM pgboss.job WHERE id = $1',
          [jobId],
        );
        return rows[0] && ['completed', 'failed'].includes(rows[0].state) ? rows[0] : undefined;
      },
      { what: `${queue} to finish` },
    );
  };
  const jobOf = (queue: string, bookingId: string) =>
    jobsOfQueue(fx.admin, queue, { key: 'bookingId', value: bookingId });
  const done = (queue: string, bookingId: string) =>
    eventually(async () => (await jobOf(queue, bookingId)).find((j) => j.state === 'completed'), {
      what: `${queue} for ${bookingId}`,
    });
  const mailFor = async (needle: string) =>
    eventually(
      async () => {
        const found = (await mailpitMessagesTo(agent.email)).filter((m) => m.Text.includes(needle));
        return found[0];
      },
      { what: `an email about ${needle}` },
    );

  it('holds.expire: an ended hold becomes EXPIRED, its slot is free again, the agent is emailed, the audit says SYSTEM', async () => {
    const b = await booking({});
    expect(await occupancyActive(b.sessionId)).toBe(true);
    await runScan(JOB_NAMES.HOLDS_EXPIRE);
    const job = await done(JOB_NAMES.HOLDS_EXPIRE_RUN, b.id);
    expect(job.data).toEqual({ tenantId, bookingId: b.id }); // identifiers only
    expect(job.output).toEqual({ result: 'EXPIRED' });
    expect((await row(b.id)).status).toBe('EXPIRED');
    expect(await occupancyActive(b.sessionId)).toBe(false);

    const mail = await mailFor(`BK-2027-${b.id.slice(-4)}`);
    expect(mail.Subject).toBe(`Hold expired: BK-2027-${b.id.slice(-4)} (Hina <Malik>)`);
    expect(mail.Text).toContain('Hello Sara Agent');
    expect(mail.Text).toContain(`http://localhost:3000/bookings/${b.id}`);
    expect(mail.From.Name).toBe('Royal Hall');
    const audit = await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.auditLog.findMany({ where: { tenantId, entityId: b.id, action: 'booking.expire' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null });

    // A second scan finds nothing to do for it.
    await runScan(JOB_NAMES.HOLDS_EXPIRE);
    expect(await jobOf(JOB_NAMES.HOLDS_EXPIRE_RUN, b.id)).toHaveLength(1);
  });

  it('holds.expire leaves alone: a hold with time left, a confirmed booking, a draft', async () => {
    const running = await booking({ holdExpiresAt: new Date(Date.now() + 24 * HOUR) });
    const confirmed = await booking({ status: 'CONFIRMED', holdExpiresAt: null });
    await runScan(JOB_NAMES.HOLDS_EXPIRE);
    for (const b of [running, confirmed])
      expect(await jobOf(JOB_NAMES.HOLDS_EXPIRE_RUN, b.id), b.id).toEqual([]);
    expect((await row(running.id)).status).toBe('TENTATIVE');
    expect(await occupancyActive(running.sessionId)).toBe(true);
  });

  it('a hold that was extended in the meantime is not expired (the job re-checks)', async () => {
    const b = await booking({});
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.booking.updateMany({
        where: { id: b.id },
        data: { holdExpiresAt: new Date(Date.now() + 48 * HOUR) },
      }),
    );
    await boss.send(
      JOB_NAMES.HOLDS_EXPIRE_RUN,
      { tenantId, bookingId: b.id },
      { singletonKey: `manual:${b.id}` },
    );
    const job = await done(JOB_NAMES.HOLDS_EXPIRE_RUN, b.id);
    expect(job.output).toEqual({ result: 'NOT_EXPIRED' });
    expect((await row(b.id)).status).toBe('TENTATIVE');
  });

  it('holds.warn: one email when the hold ends within the warning hours; the stamp does not bump rev; never twice', async () => {
    const b = await booking({ holdExpiresAt: new Date(Date.now() + 2 * HOUR) });
    const far = await booking({ holdExpiresAt: new Date(Date.now() + 30 * HOUR) });
    const before = await row(b.id);
    await runScan(JOB_NAMES.HOLDS_EXPIRE);
    const job = await done(JOB_NAMES.HOLDS_WARN_RUN, b.id);
    expect(job.output).toEqual({ result: 'WARNED' });
    const mail = await mailFor(`BK-2027-${b.id.slice(-4)}`);
    expect(mail.Subject).toContain('Hold ending soon');
    const after = await row(b.id);
    expect(after.holdWarnedAt).not.toBeNull();
    expect(after.rev).toBe(before.rev);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await jobOf(JOB_NAMES.HOLDS_WARN_RUN, far.id)).toEqual([]);
    await runScan(JOB_NAMES.HOLDS_EXPIRE);
    expect(await jobOf(JOB_NAMES.HOLDS_WARN_RUN, b.id)).toHaveLength(1);
    // An extension makes the booking due for a new warning.
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.booking.updateMany({
        where: { id: b.id },
        data: { holdExpiresAt: new Date(Date.now() + HOUR), holdWarnedAt: null },
      }),
    );
    expect((await row(b.id)).rev).toBe(before.rev + 1); // a real change bumps rev
  });

  it('bookings.complete: a finished, fully paid booking is COMPLETED; an unpaid one stays CONFIRMED', async () => {
    const over = new Date(Date.now() - 30 * HOUR);
    const paid = await booking({
      status: 'CONFIRMED',
      holdExpiresAt: null,
      sessionEnds: over,
      grandTotal: '100000',
    });
    const unpaid = await booking({
      status: 'CONFIRMED',
      holdExpiresAt: null,
      sessionEnds: over,
      grandTotal: '100000',
    });
    const recent = await booking({
      status: 'CONFIRMED',
      holdExpiresAt: null,
      sessionEnds: new Date(Date.now() - 5 * HOUR),
    });
    await fx.tenantDb.tx({ tenantId }, async (tx) => {
      await tx.payment.create({
        data: {
          tenantId,
          bookingId: paid.id,
          method: 'CASH',
          amount: '100000',
          status: 'CLEARED',
          entryType: 'RECEIPT',
        },
      });
      await tx.payment.create({
        data: {
          tenantId,
          bookingId: unpaid.id,
          method: 'CASH',
          amount: '99999.99',
          status: 'CLEARED',
          entryType: 'RECEIPT',
        },
      });
    });
    await runScan(JOB_NAMES.BOOKINGS_COMPLETE);
    expect((await done(JOB_NAMES.BOOKINGS_COMPLETE_RUN, paid.id)).output).toEqual({
      result: 'COMPLETED',
    });
    expect((await done(JOB_NAMES.BOOKINGS_COMPLETE_RUN, unpaid.id)).output).toEqual({
      result: 'BALANCE_DUE',
    });
    expect((await row(paid.id)).status).toBe('COMPLETED');
    expect((await row(unpaid.id)).status).toBe('CONFIRMED');
    expect(await jobOf(JOB_NAMES.BOOKINGS_COMPLETE_RUN, recent.id)).toEqual([]);
    expect((await row(recent.id)).status).toBe('CONFIRMED');
    expect(await occupancyActive(paid.sessionId)).toBe(true); // history still blocks (docs/05 section 2)
  });

  it('pdf.render kind "quotation": renders the frozen snapshot with real Chromium, stores it under the tenant prefix, records the KEY', async () => {
    const b = await booking({
      status: 'TENTATIVE',
      holdExpiresAt: new Date(Date.now() + 24 * HOUR),
    });
    const quotationId = uid('quo');
    const money = (v: string) => v;
    const snapshot = {
      currency: 'PKR',
      sessions: [
        {
          id: b.sessionId,
          index: 0,
          status: 'ACTIVE',
          spaceId,
          spaceName: 'Hall A',
          date: '2031-01-01',
          slotId: 's',
          slotName: 'Dinner',
          startsAt: '2031-01-01T14:00:00.000Z',
          endsAt: '2031-01-01T18:30:00.000Z',
          hours: '4.5',
          eventTypeId: null,
          eventTypeName: 'Barat',
          packageId: null,
          packageName: null,
          guests: 200,
          guaranteedGuests: null,
          billedGuests: 200,
          addOns: [],
          setupNotes: 'Stage <left>',
          kitchenNotes: null,
          subtotal: money('100000.00'),
        },
      ],
      lines: [
        {
          id: null,
          sessionIndex: 0,
          kind: 'RENT',
          description: 'Rent: Barat, Hall A, Dinner',
          refType: null,
          refId: null,
          quantity: '1',
          unitPrice: '100000.00',
          amount: '100000.00',
          taxAmount: '0.00',
          grossAmount: '100000.00',
        },
        {
          id: null,
          sessionIndex: null,
          kind: 'TAX',
          description: 'GST (16%)',
          refType: 'tax_rate',
          refId: 't',
          quantity: '1',
          unitPrice: '16000.00',
          amount: '16000.00',
          taxAmount: '0.00',
          grossAmount: '16000.00',
        },
      ],
      totals: {
        subtotal: '100000.00',
        discountTotal: '0.00',
        taxTotal: '16000.00',
        grandTotal: '116000.00',
      },
      taxRate: { id: 't', name: 'GST', ratePct: '16', inclusive: false },
      discount: null,
    };
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.quotation.create({
        data: {
          id: quotationId,
          tenantId,
          bookingId: b.id,
          version: 1,
          number: 'BK-Q-2027-0001',
          currency: 'PKR',
          lineItems: snapshot,
          subtotal: '100000',
          discountTotal: '0',
          taxTotal: '16000',
          grandTotal: '116000',
          validUntil: new Date('2031-01-15T00:00:00Z'),
        },
      }),
    );
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      fx.queue.send(
        tx,
        JOB_NAMES.PDF_RENDER,
        { tenantId, kind: 'quotation', entityId: quotationId },
        { singletonKey: `quotation:${quotationId}` },
      ),
    );
    const key = pdfObjectKey(tenantId, 'quotation', quotationId);
    const saved = await eventually(
      async () =>
        (
          await fx.tenantDb.tx({ tenantId }, (tx) =>
            tx.quotation.findFirstOrThrow({ where: { id: quotationId } }),
          )
        ).pdfKey,
      { timeoutMs: 90_000, what: 'the quotation PDF key' },
    );
    expect(saved).toBe(key);
    const s3 = testS3();
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: 'venueos-test', Key: key }));
      const bytes = Buffer.from(
        await (
          object.Body as { transformToByteArray(): Promise<Uint8Array> }
        ).transformToByteArray(),
      );
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.length).toBeGreaterThan(5_000);
    } finally {
      s3.destroy();
    }
    // The job payload held identifiers only.
    const jobs = await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
      key: 'entityId',
      value: quotationId,
    });
    expect(jobs[0]?.data).toEqual({ tenantId, kind: 'quotation', entityId: quotationId });
  }, 120_000);

  it('email.send with an attachment: the file arrives in Mailpit; the queue row holds the KEY only', async () => {
    const to = uniqueRecipient();
    const key = pdfObjectKey(tenantId, 'quotation', uid('att'));
    const pdf = Buffer.from('%PDF-1.4\n% attachment test\n');
    const s3 = testS3();
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: 'venueos-test',
          Key: key,
          Body: pdf,
          ContentType: 'application/pdf',
        }),
      );
    } finally {
      s3.destroy();
    }
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, {
        to,
        template: 'quotation.send',
        locale: 'en',
        attachments: [{ key, filename: 'BK-Q-2027-0001-v1.pdf' }],
        vars: {
          customerName: 'Hina',
          tenantName: 'Royal Hall',
          agentName: 'Sara',
          quotationNumber: 'BK-Q-2027-0001',
          version: 1,
          validUntil: '2031-01-15',
          grandTotal: 'PKR 116000.00',
          summary: 'Barat: 2031-01-01',
          message: '',
        },
      }),
    );
    const queued = await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.messageLog.findFirstOrThrow({ where: { messageKey } }),
    );
    expect(queued.attachments).toEqual([{ key, filename: 'BK-Q-2027-0001-v1.pdf' }]);
    const [mail] = await eventually(
      async () => {
        const found = await mailpitMessagesTo(to);
        return found.length > 0 ? found : undefined;
      },
      { what: 'the email with its attachment' },
    );
    const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${mail?.ID}`)).json()) as {
      Attachments: { FileName: string; ContentType: string; Size: number }[];
    };
    expect(full.Attachments).toHaveLength(1);
    expect(full.Attachments[0]).toMatchObject({
      FileName: 'BK-Q-2027-0001-v1.pdf',
      ContentType: 'application/pdf',
      Size: pdf.length,
    });
    expect(worker.rawLogs()).not.toContain('attachment test');
  });

  it('an attachment of another tenant cannot even be queued; a missing file fails with a fixed code and is retried', async () => {
    await expect(
      fx.tenantDb.tx({ tenantId }, (tx) =>
        enqueueEmail(fx.queue, tx, tenantId, {
          to: uniqueRecipient(),
          template: 'sample.hello',
          locale: 'en',
          vars: { name: 'x', venue: 'y', booking: { number: 'z' } },
          attachments: [{ key: `tenants/${uid('other')}/pdf/quotation/x.pdf`, filename: 'x.pdf' }],
        }),
      ),
    ).rejects.toThrow(/attachment key must belong to the tenant/);

    const to = uniqueRecipient();
    const { messageKey } = await fx.tenantDb.tx({ tenantId }, (tx) =>
      enqueueEmail(fx.queue, tx, tenantId, {
        to,
        template: 'sample.hello',
        locale: 'en',
        vars: { name: 'x', venue: 'y', booking: { number: 'z' } },
        attachments: [
          { key: pdfObjectKey(tenantId, 'quotation', uid('missing')), filename: 'missing.pdf' },
        ],
      }),
    );
    const failed = await eventually(
      async () => {
        const rows = await fx.tenantDb.tx({ tenantId }, (tx) =>
          tx.messageLog.findMany({ where: { messageKey, status: 'failed' } }),
        );
        return rows[0];
      },
      { what: 'the failed row' },
    );
    expect(failed).toMatchObject({ error: 'ATTACHMENT_UNAVAILABLE', isFinal: false });
    expect(await mailpitMessagesTo(to)).toEqual([]);
  });
});
