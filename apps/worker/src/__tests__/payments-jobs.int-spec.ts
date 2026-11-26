import { randomUUID } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
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

// Module 9 in the worker: the receipt PDF (real Chromium, stored under the tenant prefix, key in receipt_files), the receipt
// email with the PDF attached (a cleared receipt once; a cheque when it clears; never for a reversed one), and the payment-due
// reminder (once per item, only after 09:00 of the workspace's own clock, never for a paid item or a cancelled booking).

const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const DAY = 86_400_000;

/** A time zone in which it is `hour` o'clock right now (Etc/GMT zones have whole-hour offsets from UTC). */
function zoneWithLocalHour(hour: number): string {
  const utc = new Date().getUTCHours();
  let offset = (hour - utc + 24) % 24;
  if (offset > 14) offset -= 24;
  if (offset === 0) return 'UTC';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}
const localDate = (zone: string, offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * DAY));

describe('payment jobs', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  let boss: PgBossService['boss'];

  beforeAll(async () => {
    fx = await createFixture();
    await ensureTestBucket();
    worker = await startWorker();
    boss = worker.get<PgBossService>(PgBossService).boss;
  }, 60_000);
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  interface World {
    tenantId: string;
    venueId: string;
    customerId: string;
    email: string;
  }

  async function world(zone = 'Asia/Karachi'): Promise<World> {
    const tenantId = await createTenant(fx.tenantDb, 'Royal Hall');
    const venueId = uid('ven');
    const customerId = uid('cus');
    const email = uniqueRecipient();
    await fx.tenantDb.tx({ tenantId }, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { timezone: zone } });
      await tx.venue.create({ data: { id: venueId, tenantId, name: 'Main Hall', photoKeys: [] } });
      await tx.customer.create({
        data: { id: customerId, tenantId, name: 'Hina <Malik>', phone: '+923001234567', email },
      });
    });
    return { tenantId, venueId, customerId, email };
  }

  async function booking(
    w: World,
    options: { status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'; paidTotal?: string } = {},
  ): Promise<string> {
    const id = uid('bk');
    await fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
      tx.booking.create({
        data: {
          id,
          tenantId: w.tenantId,
          venueId: w.venueId,
          customerId: w.customerId,
          status: options.status ?? 'CONFIRMED',
          currency: 'PKR',
          quoteVersion: 1,
          number: `BK-2027-${id.slice(-4)}`,
          grandTotal: '100000',
          paidTotal: options.paidTotal ?? '0',
        },
      }),
    );
    return id;
  }

  async function payment(
    w: World,
    bookingId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; receiptNo: string }> {
    const id = uid('pay');
    const receiptNo = `BK-R-2027-${Math.floor(Math.random() * 90000 + 10000)}`;
    await fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
      tx.payment.create({
        data: {
          id,
          tenantId: w.tenantId,
          bookingId,
          entryType: 'RECEIPT',
          method: 'CASH',
          amount: '50000',
          status: 'CLEARED',
          clearedAt: new Date(),
          receiptNo,
          ...over,
        } as never,
      }),
    );
    return { id, receiptNo };
  }

  const renderReceipt = (w: World, paymentId: string, stage: string) =>
    fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
      fx.queue.send(
        tx,
        JOB_NAMES.PDF_RENDER,
        { tenantId: w.tenantId, kind: 'receipt', entityId: paymentId },
        { singletonKey: `receipt:${paymentId}:${stage}` },
      ),
    );
  const receiptFile = (w: World, paymentId: string) =>
    fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
      tx.receiptFile.findFirst({ where: { paymentId } }),
    );
  const finished = (paymentId: string, count: number) =>
    eventually(
      async () => {
        const jobs = (
          await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
            key: 'entityId',
            value: paymentId,
          })
        ).filter((j) => j.state === 'completed');
        return jobs.length >= count ? jobs : undefined;
      },
      { timeoutMs: 90_000, what: `${count} receipt render(s)` },
    );
  const receiptMails = async (email: string) =>
    (await mailpitMessagesTo(email)).filter((m) => m.Subject.startsWith('Receipt '));
  const sentLogs = (w: World, paymentId: string) =>
    fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
      tx.messageLog.findMany({
        where: {
          tenantId: w.tenantId,
          entityId: paymentId,
          event: 'receipt.sent',
          status: 'queued',
        },
      }),
    );

  describe('the receipt', () => {
    it('renders the PDF with real Chromium, stores it under the tenant prefix, records the KEY, and emails it once', async () => {
      const w = await world();
      const b = await booking(w, { paidTotal: '50000' });
      const p = await payment(w, b);
      await renderReceipt(w, p.id, 'first');
      const file = await eventually(() => receiptFile(w, p.id), {
        timeoutMs: 90_000,
        what: 'the receipt file',
      });
      expect(file.pdfKey).toBe(pdfObjectKey(w.tenantId, 'receipt', p.id));
      const s3 = testS3();
      try {
        const object = await s3.send(
          new GetObjectCommand({ Bucket: 'venueos-test', Key: file.pdfKey }),
        );
        const bytes = Buffer.from(
          await (
            object.Body as { transformToByteArray(): Promise<Uint8Array> }
          ).transformToByteArray(),
        );
        expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
        expect(bytes.length).toBeGreaterThan(3_000);
      } finally {
        s3.destroy();
      }
      // The job payload held identifiers only.
      const jobs = await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
        key: 'entityId',
        value: p.id,
      });
      expect(jobs[0]?.data).toEqual({ tenantId: w.tenantId, kind: 'receipt', entityId: p.id });

      // The customer gets the receipt with the PDF attached.
      const [mail] = await eventually(
        async () => {
          const found = await receiptMails(w.email);
          return found.length > 0 ? found : undefined;
        },
        { what: 'the receipt email' },
      );
      expect(mail?.Subject).toBe(`Receipt ${p.receiptNo} from Royal Hall`);
      expect(mail?.Text).toContain('PKR 50,000.00');
      const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${mail?.ID}`)).json()) as {
        Attachments: { FileName: string; ContentType: string }[];
      };
      expect(full.Attachments).toHaveLength(1);
      expect(full.Attachments[0]).toMatchObject({
        FileName: `${p.receiptNo}.pdf`,
        ContentType: 'application/pdf',
      });

      // A second render of the same receipt (a re-render) must not send a second email.
      await renderReceipt(w, p.id, 'again');
      await finished(p.id, 2);
      expect(await receiptMails(w.email)).toHaveLength(1);
      expect(await sentLogs(w, p.id)).toHaveLength(1);
    }, 180_000);

    it('a cheque that has not cleared gets its PDF but no email; it is emailed when it clears', async () => {
      const w = await world();
      const b = await booking(w);
      const p = await payment(w, b, {
        method: 'CHEQUE',
        status: 'PENDING',
        clearedAt: null,
        reference: 'CH-1',
      });
      await renderReceipt(w, p.id, 'first');
      await eventually(() => receiptFile(w, p.id), { timeoutMs: 90_000, what: 'the receipt file' });
      await finished(p.id, 1);
      expect(await receiptMails(w.email)).toEqual([]);
      expect(await sentLogs(w, p.id)).toEqual([]);

      await fx.tenantDb.tx({ tenantId: w.tenantId }, (tx) =>
        tx.payment.updateMany({
          where: { id: p.id },
          data: { status: 'CLEARED', clearedAt: new Date() },
        }),
      );
      await renderReceipt(w, p.id, 'cleared');
      const mails = await eventually(
        async () => {
          const found = await receiptMails(w.email);
          return found.length > 0 ? found : undefined;
        },
        { what: 'the email after the cheque cleared' },
      );
      expect(mails).toHaveLength(1);
      expect(await sentLogs(w, p.id)).toHaveLength(1);
    }, 180_000);

    it('a reversed receipt, and a customer without an address, get a PDF but no email', async () => {
      const w = await world();
      const b = await booking(w);
      const p = await payment(w, b);
      await payment(w, b, {
        entryType: 'REVERSAL',
        receiptNo: null,
        reversesId: p.id,
        notes: 'Entered twice',
      });
      await renderReceipt(w, p.id, 'first');
      await eventually(() => receiptFile(w, p.id), { timeoutMs: 90_000, what: 'the receipt file' });
      await finished(p.id, 1);
      expect(await receiptMails(w.email)).toEqual([]);

      const noMail = await world();
      await fx.tenantDb.tx({ tenantId: noMail.tenantId }, (tx) =>
        tx.customer.update({ where: { id: noMail.customerId }, data: { email: null } }),
      );
      const nb = await booking(noMail);
      const np = await payment(noMail, nb);
      await renderReceipt(noMail, np.id, 'first');
      await eventually(() => receiptFile(noMail, np.id), {
        timeoutMs: 90_000,
        what: 'the receipt file',
      });
      await finished(np.id, 1);
      expect(await sentLogs(noMail, np.id)).toEqual([]);
    }, 180_000);

    it('an unknown payment and a payment of another tenant fail permanently without a file', async () => {
      const w = await world();
      const other = await world();
      const b = await booking(other);
      const p = await payment(other, b);
      // The job of this tenant names a payment of another tenant: row level security hides it.
      await renderReceipt(w, p.id, 'first');
      await renderReceipt(w, 'no_such_payment', 'first');
      await eventually(
        async () => {
          const jobs = [
            ...(await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
              key: 'entityId',
              value: p.id,
            })),
            ...(await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
              key: 'entityId',
              value: 'no_such_payment',
            })),
          ].filter((j) => j.data && (j.data as { tenantId?: string }).tenantId === w.tenantId);
          return jobs.length === 2 && jobs.every((j) => j.state === 'failed') ? jobs : undefined;
        },
        { timeoutMs: 60_000, what: 'both jobs to fail' },
      );
      expect(await receiptFile(other, p.id)).toBeNull();
      expect(await receiptFile(w, p.id)).toBeNull();
    }, 120_000);
  });

  describe('reminders.payment-due', () => {
    const scan = async () => {
      const jobId = await boss.send(JOB_NAMES.PAYMENT_DUE, {});
      await eventually(
        async () => {
          const { rows } = await fx.admin.query<{ state: string }>(
            'SELECT state FROM pgboss.job WHERE id = $1',
            [jobId],
          );
          return rows[0] && ['completed', 'failed'].includes(rows[0].state) ? rows[0] : undefined;
        },
        { what: 'the scan to finish' },
      );
    };
    const item = (
      w: World,
      bookingId: string,
      label: string,
      dueDate: string,
      amount = '100000',
    ) => {
      const id = uid('psi');
      return fx.tenantDb
        .tx({ tenantId: w.tenantId }, (tx) =>
          tx.paymentScheduleItem.create({
            data: {
              id,
              tenantId: w.tenantId,
              bookingId,
              label,
              dueDate: new Date(`${dueDate}T00:00:00Z`),
              amount,
            },
          }),
        )
        .then(() => id);
    };
    const runs = (itemId: string) =>
      jobsOfQueue(fx.admin, JOB_NAMES.PAYMENT_DUE_RUN, { key: 'itemId', value: itemId });
    const done = (itemId: string) =>
      eventually(async () => (await runs(itemId)).find((j) => j.state === 'completed'), {
        what: `the reminder job of ${itemId}`,
      });
    const reminded = (w: World, itemId: string) =>
      fx.tenantDb.tx(
        { tenantId: w.tenantId },
        async (tx) =>
          (await tx.paymentScheduleItem.findFirstOrThrow({ where: { id: itemId } })).reminded,
      );
    const dueMails = async (email: string) =>
      (await mailpitMessagesTo(email)).filter((m) => m.Subject.startsWith('Payment due'));

    it('emails the customer once for an item due within the reminder days, after 09:00 of the workspace clock', async () => {
      const zone = zoneWithLocalHour(12);
      const w = await world(zone);
      const b = await booking(w);
      const dueSoon = await item(w, b, 'Balance', localDate(zone, 2));
      const dueFar = await item(w, b, 'Later', localDate(zone, 30));
      await scan();
      const job = await done(dueSoon);
      expect(job.output).toEqual({ result: 'REMINDED' });
      expect(job.data).toEqual({ tenantId: w.tenantId, itemId: dueSoon }); // identifiers only
      const [mail] = await eventually(
        async () => {
          const found = await dueMails(w.email);
          return found.length > 0 ? found : undefined;
        },
        { what: 'the reminder email' },
      );
      expect(mail?.Subject).toContain(`booking BK-2027-`);
      expect(mail?.Text).toContain('Balance payment of PKR 100,000.00');
      expect(mail?.Text).toContain('Dear Hina <Malik>');
      expect(mail?.From.Name).toBe('Royal Hall');
      expect(await reminded(w, dueSoon)).toBe(true);
      // Not due soon: no job at all.
      expect(await runs(dueFar)).toEqual([]);
      expect(await reminded(w, dueFar)).toBe(false);
      // A second scan sends nothing more.
      await scan();
      expect(await runs(dueSoon)).toHaveLength(1);
      expect(await dueMails(w.email)).toHaveLength(1);
    }, 120_000);

    it('waits for 09:00 of the workspace clock: a workspace where it is 03:00 is not reminded yet', async () => {
      const w = await world(zoneWithLocalHour(3));
      const b = await booking(w);
      const id = await item(w, b, 'Advance', localDate(zoneWithLocalHour(3), 1));
      await scan();
      // Another workspace's item is found in the same scan, so the scan has run; this one was left alone.
      const late = await world(zoneWithLocalHour(12));
      const lb = await booking(late);
      const lateItem = await item(late, lb, 'Advance', localDate(zoneWithLocalHour(12), 1));
      await scan();
      await done(lateItem);
      expect(await runs(id)).toEqual([]);
      expect(await reminded(w, id)).toBe(false);
    }, 120_000);

    it('an item that is already paid is only marked as handled: no email', async () => {
      const zone = zoneWithLocalHour(12);
      const w = await world(zone);
      const b = await booking(w, { paidTotal: '100000' });
      await payment(w, b, { amount: '100000' });
      const id = await item(w, b, 'Balance', localDate(zone, 1));
      await scan();
      const job = await done(id);
      expect(job.output).toEqual({ result: 'PAID' });
      expect(await reminded(w, id)).toBe(true);
      expect(await dueMails(w.email)).toEqual([]);
    }, 120_000);

    it('FIFO decides what is owed: money paid covers the first item, the second is reminded with what is left of it', async () => {
      const zone = zoneWithLocalHour(12);
      const w = await world(zone);
      const b = await booking(w);
      await payment(w, b, { amount: '60000' });
      const first = await item(w, b, 'Advance', localDate(zone, 1), '50000');
      const second = await item(w, b, 'Balance', localDate(zone, 2), '50000');
      await scan();
      expect((await done(first)).output).toEqual({ result: 'PAID' });
      expect((await done(second)).output).toEqual({ result: 'REMINDED' });
      const [mail] = await eventually(
        async () => {
          const found = await dueMails(w.email);
          return found.length > 0 ? found : undefined;
        },
        { what: 'the reminder email' },
      );
      expect(mail?.Text).toContain('Balance payment of PKR 40,000.00');
    }, 120_000);

    it('a cancelled booking and a customer without an address get no email', async () => {
      const zone = zoneWithLocalHour(12);
      const w = await world(zone);
      const cancelled = await booking(w, { status: 'CANCELLED' });
      const c = await item(w, cancelled, 'Advance', localDate(zone, 1));
      const noMail = await world(zone);
      await fx.tenantDb.tx({ tenantId: noMail.tenantId }, (tx) =>
        tx.customer.update({ where: { id: noMail.customerId }, data: { email: null } }),
      );
      const nb = await booking(noMail);
      const n = await item(noMail, nb, 'Advance', localDate(zone, 1));
      await scan();
      expect((await done(n)).output).toEqual({ result: 'NO_RECIPIENT' });
      expect(await runs(c)).toEqual([]);
      expect(await reminded(noMail, n)).toBe(true);
      expect(await dueMails(w.email)).toEqual([]);
    }, 120_000);
  });
});
