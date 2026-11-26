import { randomUUID } from 'node:crypto';
import {
  PaymentSchema,
  PaymentsOverviewSchema,
  ReceivablesResponseSchema,
  ReceivablesSummarySchema,
  RefundRequestListResponseSchema,
  RefundRequestSchema,
} from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  bookingWorld,
  createQuotation,
  day,
  getBooking,
  heldBooking,
  memberAuth,
  quoteBody,
  session,
} from '../../../__tests__/helpers/booking-fixtures';
import type { BookingWorld } from '../../../__tests__/helpers/booking-fixtures';
import { code } from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

// Module 9: payments, the payment schedule, receipts, refunds and receivables (docs/05 sections 5-6, docs/04 section 7).
// Every figure below is worked out by hand: one Dinner in Hall A is 100,000.00 (no tax), so the default schedule is an Advance
// of 50,000.00 and a Balance of 50,000.00.

interface Fx extends BookingWorld {
  accountant: Record<string, string>;
  manager: Record<string, string>;
  agent: Record<string, string>;
  ops: Record<string, string>;
  accountantUserId: string;
}

describe('payments endpoints', () => {
  let t: TestApp;
  let world: World;

  beforeAll(async () => {
    // The receipt link is signed for the local object store (nothing is read from it).
    process.env.AWS_ACCESS_KEY_ID ??= 'venueos';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'venueos-local-secret';
    world = new World();
    t = await createTestApp({
      env: {
        S3_BUCKET: 'venueos-test',
        S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
        S3_FORCE_PATH_STYLE: 'true',
        S3_REGION: 'us-east-1',
      },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const key = (): string => `k-${randomUUID()}`;

  /** A workspace ready to book, with an accountant, a branch manager, a sales agent and an operations person. */
  async function fixture(options: { people?: boolean } = {}): Promise<Fx> {
    const fx = await bookingWorld(t, world);
    if (options.people === false) {
      return { ...fx, accountant: {}, manager: {}, agent: {}, ops: {}, accountantUserId: '' };
    }
    const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
    const manager = await world.addMember(fx.c.tenant, { role: 'branch_manager' });
    const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
    const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
    return {
      ...fx,
      accountant: memberAuth(t, accountant, fx.c),
      manager: memberAuth(t, manager, fx.c),
      agent: memberAuth(t, agent, fx.c),
      ops: memberAuth(t, ops, fx.c),
      accountantUserId: accountant.userId,
    };
  }

  const record = (
    fx: Fx,
    bookingId: string,
    body: object,
    auth: Record<string, string> = fx.accountant,
    k: string = key(),
  ) =>
    t
      .http()
      .post(`/v1/bookings/${bookingId}/payments`)
      .set(auth)
      .set('Idempotency-Key', k)
      .send(body);
  const cash = (amount: string, over: object = {}) => ({ method: 'CASH', amount, ...over });
  const overview = (fx: Fx, bookingId: string, auth: Record<string, string> = fx.accountant) =>
    t.http().get(`/v1/bookings/${bookingId}/payments`).set(auth);
  const ok = async (fx: Fx, bookingId: string) => {
    const res = await overview(fx, bookingId);
    expect(res.status).toBe(200);
    return PaymentsOverviewSchema.parse(res.body);
  };
  const held = (fx: Fx, body: object = quoteBody(fx)) => heldBooking(t, fx, body);
  const confirm = (fx: Fx, b: { id: string; rev: number }, extra: object = {}) =>
    t
      .http()
      .post(`/v1/bookings/${b.id}/confirm`)
      .set(fx.c.auth)
      .send({ rev: b.rev, ...extra });
  /** A confirmed booking: held, the advance paid in cash, confirmed. */
  async function confirmed(fx: Fx, body: object = quoteBody(fx)) {
    const b = await held(fx, body);
    const total = Number(b.totals.grandTotal);
    expect((await record(fx, b.id, cash((total / 2).toFixed(2)))).status).toBe(201);
    const fresh = await getBooking(t, fx, b.id);
    const res = await confirm(fx, fresh);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; rev: number; number: string };
  }
  const cancel = (fx: Fx, b: { id: string; rev: number }) =>
    t
      .http()
      .post(`/v1/bookings/${b.id}/cancel`)
      .set(fx.c.auth)
      .send({ rev: b.rev, reason: 'Customer changed the plan' });
  const auditActions = (fx: Fx, entityId: string) =>
    world.db.tx({ tenantId: fx.c.tenant.id }, async (tx) =>
      (await tx.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } })).map(
        (a) => a.action,
      ),
    );

  // ───────────────────────────── the schedule ─────────────────────────────

  describe('the payment schedule', () => {
    it('is generated when the slot is held: Advance 50% when the hold ends, Balance 7 days before the first session', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const o = await ok(fx, b.id);
      expect(o.schedule.map((i) => [i.label, i.amount, i.status])).toEqual([
        ['Advance', '50000.00', 'UNPAID'],
        ['Balance', '50000.00', 'UNPAID'],
      ]);
      expect(o.schedule[1]?.dueDate).toBe('2030-12-25'); // 2031-01-01 minus 7 days
      expect((o.schedule[0]?.dueDate ?? '') <= (o.schedule[1]?.dueDate ?? '')).toBe(true);
      expect(o.summary).toMatchObject({
        grandTotal: '100000.00',
        paidTotal: '0.00',
        balanceDue: '100000.00',
        advanceRequired: '50000.00',
        advanceMet: false,
        readyToConfirm: false,
      });
      expect(await auditActions(fx, b.id)).toContain('payment_schedule.generate');
    });

    it('adds a Token from the workspace settings; the token counts towards the advance', async () => {
      const fx = await fixture();
      const settings = await t.http().get('/v1/tenant/settings').set(fx.c.ownerAuth);
      const patched = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(fx.c.ownerAuth)
        .send({ rev: settings.body.rev, settings: { tokenAmount: '20000', balanceDueDays: 14 } });
      expect(patched.status).toBe(200);
      const b = await held(fx);
      const o = await ok(fx, b.id);
      expect(o.schedule.map((i) => [i.label, i.amount])).toEqual([
        ['Token', '20000.00'],
        ['Advance', '30000.00'],
        ['Balance', '50000.00'],
      ]);
      expect(o.schedule[2]?.dueDate).toBe('2030-12-18');
    });

    it('a draft quotation has no schedule and no payments; a held booking of another workspace is 404', async () => {
      const fx = await fixture();
      const q = await createQuotation(t, fx);
      const o = await ok(fx, q.bookingId);
      expect(o.schedule).toEqual([]);
      expect(o.payments).toEqual([]);
      const other = await fixture();
      expect((await overview(other, q.bookingId)).status).toBe(404);
    });

    it('is generated again when a new quote version changes the total, keeping its dates', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const before = await ok(fx, b.id);
      const sid = (await getBooking(t, fx, b.id)).sessions[0].id;
      const rev = (await getBooking(t, fx, b.id)).rev;
      const res = await t
        .http()
        .patch(`/v1/bookings/${b.id}/sessions/${sid}`)
        .set(fx.c.auth)
        .send({ rev, addOns: [{ addOnId: fx.addOns.fixed }] }); // Stage decor 5,000
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await ok(fx, b.id);
      expect(after.summary.grandTotal).toBe('105000.00');
      expect(after.schedule.map((i) => i.amount)).toEqual(['52500.00', '52500.00']);
      expect(after.schedule.map((i) => i.dueDate)).toEqual(before.schedule.map((i) => i.dueDate));
      expect(await auditActions(fx, b.id)).toContain('payment_schedule.regenerate');
    });

    it('PUT replaces it when the items add up to the grand total; 400 when they do not; 422 for a draft', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const put = (id: string, items: object[], auth = fx.accountant) =>
        t.http().put(`/v1/bookings/${id}/payment-schedule`).set(auth).send({ items });
      const good = await put(b.id, [
        { label: 'Token', dueDate: '2030-12-01', amount: '10000.00' },
        { label: 'Advance', dueDate: '2030-12-10', amount: '40000.00' },
        { label: 'Balance', dueDate: '2030-12-20', amount: '50000.00' },
      ]);
      expect(good.status, JSON.stringify(good.body)).toBe(200);
      expect(PaymentsOverviewSchema.parse(good.body).schedule).toHaveLength(3);
      expect(await auditActions(fx, b.id)).toContain('payment_schedule.update');
      const bad = await put(b.id, [{ label: 'All', dueDate: '2030-12-20', amount: '99999.99' }]);
      expect(bad.status).toBe(400);
      expect(bad.body.error.details?.[0]?.path ?? bad.body.error.message).toBeTruthy();
      expect((await put(b.id, [])).status).toBe(400);
      expect(
        (await put(b.id, [{ label: 'X', dueDate: '2030-02-30', amount: '100000.00' }])).status,
      ).toBe(400);
      expect(
        (await put(b.id, [{ label: 'X', dueDate: '2030-12-20', amount: '100000.005' }])).status,
      ).toBe(400);
      const q = await createQuotation(t, fx);
      const draft = await put(q.bookingId, [
        { label: 'All', dueDate: '2030-12-20', amount: '100000.00' },
      ]);
      expect(draft.status).toBe(422);
    });

    it('PUT needs payment.record (403 for a sales agent), 401 without a login, 404 for another workspace', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const items = [{ label: 'All', dueDate: '2030-12-20', amount: '100000.00' }];
      const put = (auth: Record<string, string>) =>
        t.http().put(`/v1/bookings/${b.id}/payment-schedule`).set(auth).send({ items });
      expect((await put(fx.agent)).status).toBe(403);
      expect((await put(fx.ops)).status).toBe(403);
      expect((await put(t.csrfHeaders)).status).toBe(401);
      const other = await fixture();
      expect((await put(other.accountant)).status).toBe(404);
    });

    it('applies the cleared receipts first-in-first-out, and flags what is past due as OVERDUE', async () => {
      const fx = await fixture();
      const b = await held(fx);
      await t
        .http()
        .put(`/v1/bookings/${b.id}/payment-schedule`)
        .set(fx.accountant)
        .send({
          items: [
            { label: 'Advance', dueDate: '2020-01-01', amount: '50000.00' },
            { label: 'Balance', dueDate: '2031-12-20', amount: '50000.00' },
          ],
        });
      expect((await record(fx, b.id, cash('20000.00'))).status).toBe(201);
      const first = await ok(fx, b.id);
      expect(first.schedule.map((i) => [i.status, i.allocated, i.remaining])).toEqual([
        ['OVERDUE', '20000.00', '30000.00'],
        ['UNPAID', '0.00', '50000.00'],
      ]);
      expect((await record(fx, b.id, cash('60000.00'))).status).toBe(201);
      const second = await ok(fx, b.id);
      expect(second.schedule.map((i) => [i.status, i.remaining])).toEqual([
        ['PAID', '0.00'],
        ['PARTLY', '20000.00'],
      ]);
    });
  });

  // ───────────────────────────── recording ─────────────────────────────

  describe('recording a payment', () => {
    it('a cash receipt is CLEARED at once, gets a receipt number, moves the paid total and is audited', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const res = await record(
        fx,
        b.id,
        cash('30000.00', { reference: 'Counter 1', notes: 'Part of the advance' }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const p = PaymentSchema.parse(res.body);
      expect(p).toMatchObject({
        entryType: 'RECEIPT',
        method: 'CASH',
        amount: '30000.00',
        status: 'CLEARED',
        reference: 'Counter 1',
        notes: 'Part of the advance',
        reversesId: null,
        reversedById: null,
        receiptReady: false,
      });
      expect(p.receiptNo).toMatch(/^BK-R-\d{4}-00001$/);
      expect(p.clearedAt).not.toBeNull();
      expect(p.receivedByName).toBeTruthy();
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({
        paidTotal: '30000.00',
        balanceDue: '70000.00',
        advanceMet: false,
      });
      // paid_total is kept in the same transaction and shown on the booking.
      expect((await getBooking(t, fx, b.id)).paidTotal).toBe('30000.00');
      expect(await auditActions(fx, p.id)).toEqual(['payment.record']);
    });

    it('receipt numbers run in sequence per workspace and never repeat', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const numbers: string[] = [];
      for (const amount of ['1000.00', '2000.00', '3000.00']) {
        numbers.push(
          PaymentSchema.parse((await record(fx, b.id, cash(amount))).body).receiptNo ?? '',
        );
      }
      expect(numbers.map((n) => n.slice(-5))).toEqual(['00001', '00002', '00003']);
      const other = await fixture();
      const ob = await held(other);
      expect(
        PaymentSchema.parse((await record(other, ob.id, cash('10.00'))).body).receiptNo,
      ).toMatch(/-00001$/);
    });

    it('a payment to a held booking can come before the advance: ready to confirm shows up once the advance is in, nothing confirms by itself', async () => {
      const fx = await fixture();
      const b = await held(fx);
      expect((await record(fx, b.id, cash('49999.99'))).status).toBe(201);
      expect((await ok(fx, b.id)).summary.readyToConfirm).toBe(false);
      expect((await record(fx, b.id, cash('0.01'))).status).toBe(201);
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({ advanceMet: true, readyToConfirm: true });
      expect(o.bookingStatus).toBe('TENTATIVE');
      expect((await getBooking(t, fx, b.id)).status).toBe('TENTATIVE');
    });

    it('does not bump the booking rev: a form that is open on the booking stays valid after a payment', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const rev = (await getBooking(t, fx, b.id)).rev;
      expect((await record(fx, b.id, cash('5000.00'))).status).toBe(201);
      expect((await getBooking(t, fx, b.id)).rev).toBe(rev);
    });

    it('an overpayment is accepted and shown as credit', async () => {
      const fx = await fixture();
      const b = await held(fx);
      expect((await record(fx, b.id, cash('120000.50'))).status).toBe(201);
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({
        paidTotal: '120000.50',
        credit: '20000.50',
        balanceDue: '0.00',
      });
      expect(o.schedule.every((i) => i.status === 'PAID')).toBe(true);
    });

    it('works for every method; a cheque needs its number and starts PENDING without counting', async () => {
      const fx = await fixture();
      const b = await held(fx);
      for (const method of ['BANK_TRANSFER', 'CARD', 'MOBILE_WALLET']) {
        const res = await record(fx, b.id, {
          method,
          amount: '1000.00',
          reference: `ref ${method}`,
        });
        expect(PaymentSchema.parse(res.body)).toMatchObject({ method, status: 'CLEARED' });
      }
      expect((await record(fx, b.id, { method: 'CHEQUE', amount: '40000.00' })).status).toBe(400);
      const cheque = await record(fx, b.id, {
        method: 'CHEQUE',
        amount: '40000.00',
        reference: 'CH-1001',
      });
      expect(PaymentSchema.parse(cheque.body)).toMatchObject({
        status: 'PENDING',
        clearedAt: null,
      });
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({ paidTotal: '3000.00', pendingCheques: '40000.00' });
    });

    it('validates: 400 without or with a bad Idempotency-Key, a zero, negative or too precise amount, the gateway method, a future date', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const raw = (body: object, headers: Record<string, string> = { 'Idempotency-Key': key() }) =>
        t.http().post(`/v1/bookings/${b.id}/payments`).set(fx.accountant).set(headers).send(body);
      expect((await raw(cash('10.00'), {})).status).toBe(400);
      expect((await raw(cash('10.00'), { 'Idempotency-Key': 'short' })).status).toBe(400);
      expect(
        (await raw(cash('10.00'), { 'Idempotency-Key': 'has spaces in the key' })).status,
      ).toBe(400);
      expect((await raw(cash('0.00'))).status).toBe(400);
      expect((await raw(cash('-5.00'))).status).toBe(400);
      expect((await raw(cash('10.005'))).status).toBe(400);
      expect((await raw(cash('ten'))).status).toBe(400);
      expect((await raw({ method: 'ONLINE_GATEWAY', amount: '10.00' })).status).toBe(400);
      expect((await raw({ method: 'BARTER', amount: '10.00' })).status).toBe(400);
      expect(
        (await raw(cash('10.00', { receivedAt: new Date(Date.now() + 86_400_000).toISOString() })))
          .status,
      ).toBe(400);
      expect((await raw({ amount: '10.00' })).status).toBe(400);
      expect((await ok(fx, b.id)).payments).toEqual([]);
    });

    it('a back-dated receipt keeps its date', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const when = '2026-06-01T10:00:00.000Z';
      const p = PaymentSchema.parse(
        (await record(fx, b.id, cash('1000.00', { receivedAt: when }))).body,
      );
      expect(p.receivedAt).toBe(when);
    });

    it('422 for a quotation, an expired or a cancelled booking; 404 for an unknown or foreign booking', async () => {
      const fx = await fixture();
      const q = await createQuotation(t, fx);
      expect((await record(fx, q.bookingId, cash('10.00'))).status).toBe(422);
      const b = await held(fx);
      expect((await cancel(fx, await getBooking(t, fx, b.id))).status).toBe(200);
      expect((await record(fx, b.id, cash('10.00'))).status).toBe(422);
      expect((await record(fx, 'no_such_booking', cash('10.00'))).status).toBe(404);
      const other = await fixture();
      expect((await record(other, b.id, cash('10.00'))).status).toBe(404);
    });

    it('403 without payment.record (sales agent, operations), 401 without a login', async () => {
      const fx = await fixture();
      const b = await held(fx);
      expect((await record(fx, b.id, cash('10.00'), fx.agent)).status).toBe(403);
      expect((await record(fx, b.id, cash('10.00'), fx.ops)).status).toBe(403);
      expect((await record(fx, b.id, cash('10.00'), t.csrfHeaders)).status).toBe(401);
      expect((await record(fx, b.id, cash('10.00'), fx.manager)).status).toBe(201);
    });

    it('reading needs payment.view: a sales agent may, operations may not', async () => {
      const fx = await fixture();
      const b = await held(fx);
      expect((await overview(fx, b.id, fx.agent)).status).toBe(200);
      expect((await overview(fx, b.id, fx.ops)).status).toBe(403);
      expect((await overview(fx, b.id, t.csrfHeaders)).status).toBe(401);
    });

    it('a person limited to other venues gets 404 for this booking', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const elsewhere = await world.createVenue(fx.c.tenant);
      const scoped = await world.addMember(fx.c.tenant, {
        role: 'accountant',
        venueIds: [elsewhere],
      });
      const auth = memberAuth(t, scoped, fx.c);
      expect((await overview(fx, b.id, auth)).status).toBe(404);
      expect((await record(fx, b.id, cash('10.00'), auth)).status).toBe(404);
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key returns the first result (200) and writes nothing more', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const k = key();
      const first = await record(fx, b.id, cash('7000.00'), fx.accountant, k);
      const again = await record(fx, b.id, cash('7000.00'), fx.accountant, k);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.receiptNo).toBe(first.body.receiptNo);
      const o = await ok(fx, b.id);
      expect(o.payments).toHaveLength(1);
      expect(o.summary.paidTotal).toBe('7000.00');
    });

    it('the same key with a different request is 409 IDEMPOTENCY_CONFLICT', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const k = key();
      await record(fx, b.id, cash('7000.00'), fx.accountant, k);
      const other = await record(fx, b.id, cash('7001.00'), fx.accountant, k);
      expect(other.status).toBe(409);
      expect(code(other)).toBe('IDEMPOTENCY_CONFLICT');
      const otherMethod = await record(
        fx,
        b.id,
        { method: 'CARD', amount: '7000.00' },
        fx.accountant,
        k,
      );
      expect(code(otherMethod)).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('two identical requests at the same moment write exactly one payment', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const k = key();
      const results = await Promise.all([
        record(fx, b.id, cash('1234.00'), fx.accountant, k),
        record(fx, b.id, cash('1234.00'), fx.accountant, k),
        record(fx, b.id, cash('1234.00'), fx.accountant, k),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect((await ok(fx, b.id)).payments).toHaveLength(1);
    });

    it('keys are per workspace: another workspace may use the same key', async () => {
      const a = await fixture();
      const b = await fixture();
      const k = key();
      const ba = await held(a);
      const bb = await held(b);
      expect((await record(a, ba.id, cash('1.00'), a.accountant, k)).status).toBe(201);
      expect((await record(b, bb.id, cash('1.00'), b.accountant, k)).status).toBe(201);
    });
  });

  // ───────────────────────────── cheques ─────────────────────────────

  describe('cheques', () => {
    const cheque = async (fx: Fx, bookingId: string, amount = '50000.00') =>
      PaymentSchema.parse(
        (await record(fx, bookingId, { method: 'CHEQUE', amount, reference: 'CH-9' })).body,
      );
    const act = (
      fx: Fx,
      id: string,
      action: 'clear' | 'bounce',
      body: object = {},
      auth = fx.accountant,
    ) => t.http().post(`/v1/payments/${id}/${action}`).set(auth).send(body);

    it('clear: PENDING -> CLEARED counts towards the advance and the paid total; a second clear is 422', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = await cheque(fx, b.id);
      expect((await ok(fx, b.id)).summary).toMatchObject({ paidTotal: '0.00', advanceMet: false });
      const res = await act(fx, p.id, 'clear');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(PaymentSchema.parse(res.body)).toMatchObject({ status: 'CLEARED' });
      expect(res.body.clearedAt).not.toBeNull();
      expect((await ok(fx, b.id)).summary).toMatchObject({
        paidTotal: '50000.00',
        pendingCheques: '0.00',
        advanceMet: true,
        readyToConfirm: true,
      });
      expect((await act(fx, p.id, 'clear')).status).toBe(422);
      expect(await auditActions(fx, p.id)).toEqual(['payment.record', 'payment.clear']);
    });

    it('a pending cheque is not enough to confirm; once it clears, confirming works', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = await cheque(fx, b.id);
      const blocked = await confirm(fx, await getBooking(t, fx, b.id));
      expect(blocked.status).toBe(422);
      expect(code(blocked)).toBe('ADVANCE_REQUIRED');
      await act(fx, p.id, 'clear');
      const done = await confirm(fx, await getBooking(t, fx, b.id));
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.status).toBe('CONFIRMED');
    });

    it('bounce from PENDING changes nothing in the paid total; the cheque is BOUNCED for good', async () => {
      const fx = await fixture();
      const b = await held(fx);
      await record(fx, b.id, cash('10000.00'));
      const p = await cheque(fx, b.id, '20000.00');
      const res = await act(fx, p.id, 'bounce', { reason: 'Insufficient funds' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('BOUNCED');
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({ paidTotal: '10000.00', pendingCheques: '0.00' });
      expect((await act(fx, p.id, 'bounce')).status).toBe(422);
      expect((await act(fx, p.id, 'clear')).status).toBe(422);
    });

    it('a cheque that bounces AFTER it cleared lowers the paid total, and the advance is lost again', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = await cheque(fx, b.id, '60000.00');
      await act(fx, p.id, 'clear');
      expect((await ok(fx, b.id)).summary).toMatchObject({
        paidTotal: '60000.00',
        advanceMet: true,
      });
      const res = await act(fx, p.id, 'bounce', { reason: 'Returned by the bank' });
      expect(res.status).toBe(200);
      const o = await ok(fx, b.id);
      expect(o.summary).toMatchObject({
        paidTotal: '0.00',
        advanceMet: false,
        readyToConfirm: false,
      });
      expect((await getBooking(t, fx, b.id)).paidTotal).toBe('0.00');
      expect(await auditActions(fx, p.id)).toEqual([
        'payment.record',
        'payment.clear',
        'payment.bounce',
      ]);
    });

    it('only a cheque can clear or bounce; a cash receipt is 422; 400 for a reason that is too short', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const c = PaymentSchema.parse((await record(fx, b.id, cash('100.00'))).body);
      expect((await act(fx, c.id, 'clear')).status).toBe(422);
      expect((await act(fx, c.id, 'bounce')).status).toBe(422);
      const p = await cheque(fx, b.id, '100.00');
      expect((await act(fx, p.id, 'bounce', { reason: 'x' })).status).toBe(400);
    });

    it('a cheque that was reversed cannot bounce', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = await cheque(fx, b.id, '100.00');
      await act(fx, p.id, 'clear');
      const rev = await t
        .http()
        .post(`/v1/payments/${p.id}/reverse`)
        .set(fx.accountant)
        .set('Idempotency-Key', key())
        .send({ reason: 'Entered twice by mistake' });
      expect(rev.status).toBe(201);
      expect((await act(fx, p.id, 'bounce')).status).toBe(422);
    });

    it('needs payment.record (403 for the sales agent), 404 for another workspace, 404 for an unknown id', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = await cheque(fx, b.id, '100.00');
      expect((await act(fx, p.id, 'clear', {}, fx.agent)).status).toBe(403);
      expect((await act(fx, p.id, 'clear', {}, t.csrfHeaders)).status).toBe(401);
      const other = await fixture();
      expect((await act(other, p.id, 'clear', {}, other.accountant)).status).toBe(404);
      expect((await act(fx, 'nothing_here', 'clear')).status).toBe(404);
    });
  });

  // ───────────────────────────── reversal ─────────────────────────────

  describe('reversal', () => {
    const reverse = (
      fx: Fx,
      id: string,
      body: object = { reason: 'Entered on the wrong booking' },
      auth = fx.accountant,
      k = key(),
    ) => t.http().post(`/v1/payments/${id}/reverse`).set(auth).set('Idempotency-Key', k).send(body);

    it('writes a REVERSAL that points to the original; the original is untouched; the paid total goes back', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('25000.00'))).body);
      const res = await reverse(fx, p.id);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const r = PaymentSchema.parse(res.body);
      expect(r).toMatchObject({
        entryType: 'REVERSAL',
        reversesId: p.id,
        amount: '25000.00',
        status: 'CLEARED',
        notes: 'Entered on the wrong booking',
        receiptNo: null,
      });
      const o = await ok(fx, b.id);
      expect(o.summary.paidTotal).toBe('0.00');
      const original = o.payments.find((x) => x.id === p.id);
      expect(original).toMatchObject({
        amount: '25000.00',
        status: 'CLEARED',
        entryType: 'RECEIPT',
        receiptNo: p.receiptNo,
        reversedById: r.id,
      });
      expect(await auditActions(fx, r.id)).toEqual(['payment.reverse']);
    });

    it('needs a reason (400), can only be done once (422), and a reversal cannot be reversed (422)', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('100.00'))).body);
      expect((await reverse(fx, p.id, {})).status).toBe(400);
      expect((await reverse(fx, p.id, { reason: 'no' })).status).toBe(400);
      const first = await reverse(fx, p.id);
      expect(first.status).toBe(201);
      expect((await reverse(fx, p.id)).status).toBe(422);
      expect((await reverse(fx, first.body.id)).status).toBe(422);
    });

    it('a pending or bounced cheque cannot be reversed (there is nothing to take back)', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse(
        (await record(fx, b.id, { method: 'CHEQUE', amount: '100.00', reference: 'CH-5' })).body,
      );
      expect((await reverse(fx, p.id)).status).toBe(422);
      await t.http().post(`/v1/payments/${p.id}/bounce`).set(fx.accountant).send({});
      expect((await reverse(fx, p.id)).status).toBe(422);
    });

    it('a retry with the same key returns the first reversal (200); the same key for another entry is a conflict', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p1 = PaymentSchema.parse((await record(fx, b.id, cash('100.00'))).body);
      const p2 = PaymentSchema.parse((await record(fx, b.id, cash('200.00'))).body);
      const k = key();
      const first = await reverse(fx, p1.id, undefined, fx.accountant, k);
      const again = await reverse(fx, p1.id, undefined, fx.accountant, k);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      const clash = await reverse(fx, p2.id, undefined, fx.accountant, k);
      expect(code(clash)).toBe('IDEMPOTENCY_CONFLICT');
      expect((await ok(fx, b.id)).summary.paidTotal).toBe('200.00');
    });

    it('needs payment.reverse: the branch manager and the sales agent get 403, the accountant and the owner may', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('100.00'), fx.manager)).body);
      expect((await reverse(fx, p.id, undefined, fx.manager)).status).toBe(403);
      expect((await reverse(fx, p.id, undefined, fx.agent)).status).toBe(403);
      expect((await reverse(fx, p.id, undefined, t.csrfHeaders)).status).toBe(401);
      expect((await reverse(fx, p.id, undefined, fx.c.auth)).status).toBe(201);
    });

    it('is 400 without an Idempotency-Key; 404 for another workspace', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('100.00'))).body);
      const noKey = await t
        .http()
        .post(`/v1/payments/${p.id}/reverse`)
        .set(fx.accountant)
        .send({ reason: 'Entered on the wrong booking' });
      expect(noKey.status).toBe(400);
      const other = await fixture();
      expect((await reverse(other, p.id, undefined, other.accountant)).status).toBe(404);
    });
  });

  describe('the database guards the ledger', () => {
    it('the app role cannot change an amount, a method or a receipt number, and cannot delete a payment; only status and cleared_at may move', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse(
        (await record(fx, b.id, { method: 'CHEQUE', amount: '500.00', reference: 'CH-7' })).body,
      );
      const run = (
        statement: (tx: Parameters<Parameters<typeof world.db.tx>[1]>[0]) => Promise<number>,
      ) => world.db.tx({ tenantId: fx.c.tenant.id }, statement);
      await expect(
        run((tx) => tx.$executeRaw`UPDATE payments SET amount = 1 WHERE id = ${p.id}`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        run((tx) => tx.$executeRaw`UPDATE payments SET method = 'CASH' WHERE id = ${p.id}`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        run((tx) => tx.$executeRaw`UPDATE payments SET receipt_no = 'X' WHERE id = ${p.id}`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        run((tx) => tx.$executeRaw`DELETE FROM payments WHERE id = ${p.id}`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        run(
          (tx) =>
            tx.$executeRaw`UPDATE payments SET status = 'CLEARED', cleared_at = now() WHERE id = ${p.id}`,
        ),
      ).resolves.toBe(1);
    });

    it('a receipt needs a number, nothing else has one, a cash entry cannot be PENDING', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const insert = (over: Record<string, unknown>) =>
        world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
          tx.payment.create({
            data: {
              tenantId: fx.c.tenant.id,
              bookingId: b.id,
              method: 'CASH',
              amount: '10',
              status: 'CLEARED',
              entryType: 'RECEIPT',
              ...over,
            } as never,
          }),
        );
      await expect(insert({})).rejects.toThrow(/payments_receipt_no_by_type/);
      await expect(insert({ entryType: 'REFUND', receiptNo: 'BK-R-1' })).rejects.toThrow(
        /payments_receipt_no_by_type/,
      );
      await expect(insert({ receiptNo: 'BK-R-2', status: 'PENDING' })).rejects.toThrow(
        /payments_status_by_method/,
      );
    });
  });

  // ───────────────────────────── the receipt ─────────────────────────────

  describe('the receipt', () => {
    const withFile = async (fx: Fx, paymentId: string) =>
      world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.receiptFile.create({
          data: {
            tenantId: fx.c.tenant.id,
            paymentId,
            pdfKey: `tenants/${fx.c.tenant.id}/pdf/receipt/${paymentId}.pdf`,
          },
        }),
      );

    it('the download link is 422 until the PDF exists, then a short-lived link named after the receipt', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('1000.00'))).body);
      const early = await t.http().get(`/v1/payments/${p.id}/receipt`).set(fx.accountant);
      expect(early.status).toBe(422);
      await withFile(fx, p.id);
      const res = await t.http().get(`/v1/payments/${p.id}/receipt`).set(fx.agent);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.expiresInSeconds).toBe(300);
      expect(res.body.url).toContain(`pdf/receipt/${p.id}.pdf`);
      expect(decodeURIComponent(res.body.url)).toContain(`${p.receiptNo}.pdf`);
      expect((await ok(fx, b.id)).payments[0]?.receiptReady).toBe(true);
    });

    it('the link needs payment.view (403 for operations, 401 without a login), 404 for another workspace and for a refund entry', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('1000.00'))).body);
      await withFile(fx, p.id);
      expect((await t.http().get(`/v1/payments/${p.id}/receipt`).set(fx.ops)).status).toBe(403);
      expect((await t.http().get(`/v1/payments/${p.id}/receipt`).set(t.csrfHeaders)).status).toBe(
        401,
      );
      const other = await fixture();
      expect(
        (await t.http().get(`/v1/payments/${p.id}/receipt`).set(other.accountant)).status,
      ).toBe(404);
      const rev = await t
        .http()
        .post(`/v1/payments/${p.id}/reverse`)
        .set(fx.accountant)
        .set('Idempotency-Key', key())
        .send({ reason: 'Entered on the wrong booking' });
      expect(
        (await t.http().get(`/v1/payments/${rev.body.id}/receipt`).set(fx.accountant)).status,
      ).toBe(404);
    });

    it('resend queues one email with the PDF attached by KEY; to the customer or to the address given', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('1000.00'))).body);
      const resend = (body: object = {}, auth = fx.accountant) =>
        t.http().post(`/v1/payments/${p.id}/receipt/resend`).set(auth).send(body);
      expect((await resend()).status).toBe(422); // no PDF yet
      await withFile(fx, p.id);
      const res = await resend({ to: 'sister@example.test' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.to).toBe('sister@example.test');
      const mails = await world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.messageLog.findMany({ where: { tenantId: fx.c.tenant.id, template: 'receipt.sent' } }),
      );
      expect(mails).toHaveLength(1);
      expect(mails[0]?.attachments).toEqual([
        {
          key: `tenants/${fx.c.tenant.id}/pdf/receipt/${p.id}.pdf`,
          filename: `${p.receiptNo}.pdf`,
        },
      ]);
      expect(await auditActions(fx, p.id)).toContain('payment.receipt_resend');
      expect((await resend({ to: 'not an email' })).status).toBe(400);
      expect((await resend({}, fx.agent)).status).toBe(403);
    });

    it('resend: 422 for a customer without an address, and for a cheque that has not cleared', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const cheque = PaymentSchema.parse(
        (await record(fx, b.id, { method: 'CHEQUE', amount: '100.00', reference: 'CH-3' })).body,
      );
      await withFile(fx, cheque.id);
      const resend = (id: string, body: object = {}) =>
        t.http().post(`/v1/payments/${id}/receipt/resend`).set(fx.accountant).send(body);
      expect((await resend(cheque.id, { to: 'a@example.test' })).status).toBe(422);
      await world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.customer.update({ where: { id: fx.customer.id }, data: { email: null } }),
      );
      const p = PaymentSchema.parse((await record(fx, b.id, cash('100.00'))).body);
      await withFile(fx, p.id);
      expect((await resend(p.id)).status).toBe(422);
      expect((await resend(p.id, { to: 'a@example.test' })).status).toBe(200);
    });
  });

  // ───────────────────────────── refunds ─────────────────────────────

  describe('refunds', () => {
    const request = (
      fx: Fx,
      bookingId: string,
      body: object,
      auth: Record<string, string> = fx.manager,
      k: string = key(),
    ) =>
      t
        .http()
        .post(`/v1/bookings/${bookingId}/refund-requests`)
        .set(auth)
        .set('Idempotency-Key', k)
        .send(body);
    const decide = (
      fx: Fx,
      id: string,
      action: 'approve' | 'reject' | 'pay',
      body: object,
      auth: Record<string, string> = fx.accountant,
      k: string = key(),
    ) =>
      t
        .http()
        .post(`/v1/refund-requests/${id}/${action}`)
        .set(auth)
        .set('Idempotency-Key', k)
        .send(body);
    const ask = async (fx: Fx, bookingId: string, amount: string, auth = fx.manager) => {
      const res = await request(fx, bookingId, { amount, reason: 'Customer cancelled' }, auth);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return RefundRequestSchema.parse(res.body);
    };
    let nextDay = 20;
    /** A held booking on a day of its own (one space cannot be held twice on the same day) with `amount` paid. */
    const paidBooking = async (fx: Fx, amount = '60000.00') => {
      const b = await held(fx, quoteBody(fx, [session(fx, { date: day(nextDay++) })]));
      await record(fx, b.id, cash(amount));
      return b;
    };

    it('the cancellation pre-fills the suggestion: the policy snapshot gives the refund the booking page shows', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '50000.00');
      const res = await cancel(fx, await getBooking(t, fx, b.id));
      expect(res.status).toBe(200);
      const o = await ok(fx, b.id);
      expect(o.bookingStatus).toBe('CANCELLED');
      // 2031-01-01 is more than 60 days away: the Standard policy refunds 80% of what was paid.
      expect(res.body.refund.suggested).toBe('40000.00');
      expect(o.summary.suggestedRefund).toBe('40000.00');
      expect(o.summary.refundable).toBe('50000.00');
    });

    it('a request is REQUESTED, audited, limited to what was paid; open requests count against the limit', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '10000.00');
      const r = await ask(fx, b.id, '6000.00');
      expect(r).toMatchObject({
        status: 'REQUESTED',
        amount: '6000.00',
        reason: 'Customer cancelled',
        approvedByName: null,
        selfApproved: false,
        paymentId: null,
        bookingId: b.id,
      });
      expect(await auditActions(fx, r.id)).toEqual(['refund.request']);
      const tooMuch = await request(fx, b.id, { amount: '4000.01', reason: 'Another one' });
      expect(tooMuch.status).toBe(422);
      expect((await request(fx, b.id, { amount: '4000.00', reason: 'Another one' })).status).toBe(
        201,
      );
      expect((await ok(fx, b.id)).summary.refundable).toBe('0.00');
    });

    it('validates: a reason of 3+ letters, an amount above zero with the currency decimals, a key; 422 for a quotation', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      expect((await request(fx, b.id, { amount: '10.00', reason: 'no' })).status).toBe(400);
      expect((await request(fx, b.id, { amount: '10.00' })).status).toBe(400);
      expect((await request(fx, b.id, { amount: '0.00', reason: 'Zero refund' })).status).toBe(400);
      expect((await request(fx, b.id, { amount: '10.005', reason: 'Too precise' })).status).toBe(
        400,
      );
      const noKey = await t
        .http()
        .post(`/v1/bookings/${b.id}/refund-requests`)
        .set(fx.manager)
        .send({ amount: '10.00', reason: 'No key sent' });
      expect(noKey.status).toBe(400);
      const q = await createQuotation(t, fx);
      expect(
        (await request(fx, q.bookingId, { amount: '10.00', reason: 'A quotation' })).status,
      ).toBe(422);
    });

    it('needs payment.refund.request: 403 for the sales agent and operations, 401 without a login, 404 for another workspace', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      const body = { amount: '10.00', reason: 'Because' };
      expect((await request(fx, b.id, body, fx.agent)).status).toBe(403);
      expect((await request(fx, b.id, body, fx.ops)).status).toBe(403);
      expect((await request(fx, b.id, body, t.csrfHeaders)).status).toBe(401);
      const other = await fixture();
      expect((await request(other, b.id, body, other.manager)).status).toBe(404);
    });

    it('a retry with the same key returns the first request (200); a different request with it is a conflict', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      const k = key();
      const body = { amount: '1000.00', reason: 'Customer cancelled' };
      const first = await request(fx, b.id, body, fx.manager, k);
      const again = await request(fx, b.id, body, fx.manager, k);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(code(await request(fx, b.id, { ...body, amount: '2000.00' }, fx.manager, k))).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
      const list = await t.http().get(`/v1/refund-requests?bookingId=${b.id}`).set(fx.accountant);
      expect(list.body.data).toHaveLength(1);
    });

    it('the two-person rule: the requester cannot approve their own request where someone else may; another person can', async () => {
      const fx = await fixture(); // the owner and the accountant may both approve
      const b = await paidBooking(fx);
      const r = await ask(fx, b.id, '5000.00', fx.c.auth); // requested by the owner
      const self = await decide(fx, r.id, 'approve', { rev: r.rev }, fx.c.auth);
      expect(self.status).toBe(403);
      const ok1 = await decide(fx, r.id, 'approve', {
        rev: r.rev,
        note: 'Checked with the customer',
      });
      expect(ok1.status, JSON.stringify(ok1.body)).toBe(200);
      expect(RefundRequestSchema.parse(ok1.body)).toMatchObject({
        status: 'APPROVED',
        selfApproved: false,
        decisionNote: 'Checked with the customer',
      });
      expect(ok1.body.approvedByName).toBeTruthy();
      expect(await auditActions(fx, r.id)).toEqual(['refund.request', 'refund.approve']);
      // Already decided.
      expect((await decide(fx, r.id, 'approve', { rev: ok1.body.rev })).status).toBe(422);
      expect(
        (await decide(fx, r.id, 'reject', { rev: ok1.body.rev, note: 'Too late now' })).status,
      ).toBe(422);
    });

    it('a workspace with ONE person who may approve refunds lets them approve their own request; it is recorded', async () => {
      const fx = await fixture({ people: false }); // only the owner
      const b = await held(fx);
      await t
        .http()
        .post(`/v1/bookings/${b.id}/payments`)
        .set(fx.c.auth)
        .set('Idempotency-Key', key())
        .send(cash('20000.00'));
      const asked = await t
        .http()
        .post(`/v1/bookings/${b.id}/refund-requests`)
        .set(fx.c.auth)
        .set('Idempotency-Key', key())
        .send({ amount: '1000.00', reason: 'Goodwill refund' });
      const r = RefundRequestSchema.parse(asked.body);
      const res = await t
        .http()
        .post(`/v1/refund-requests/${r.id}/approve`)
        .set(fx.c.auth)
        .send({ rev: r.rev });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'APPROVED', selfApproved: true });
      const log = await world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.auditLog.findFirst({ where: { entityId: r.id, action: 'refund.approve' } }),
      );
      expect(JSON.stringify(log?.after)).toContain('"selfApproved":true');
    });

    it('rejecting needs a note (400); a stale rev is 409; an unknown request is 404; without the permission 403', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      const r = await ask(fx, b.id, '100.00');
      expect((await decide(fx, r.id, 'reject', { rev: r.rev })).status).toBe(400);
      expect((await decide(fx, r.id, 'reject', { rev: r.rev, note: 'no' })).status).toBe(400);
      expect((await decide(fx, r.id, 'approve', { rev: r.rev + 5 })).status).toBe(409);
      expect((await decide(fx, 'unknown_id', 'approve', { rev: 1 })).status).toBe(404);
      expect((await decide(fx, r.id, 'approve', { rev: r.rev }, fx.manager)).status).toBe(403);
      expect((await decide(fx, r.id, 'approve', { rev: r.rev }, t.csrfHeaders)).status).toBe(401);
      const rejected = await decide(fx, r.id, 'reject', {
        rev: r.rev,
        note: 'Not covered by the policy',
      });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        decisionNote: 'Not covered by the policy',
      });
      // A rejected request is not payable.
      expect(
        (await decide(fx, r.id, 'pay', { rev: rejected.body.rev, method: 'CASH' })).status,
      ).toBe(422);
      const other = await fixture();
      expect((await decide(other, r.id, 'approve', { rev: r.rev }, other.accountant)).status).toBe(
        404,
      );
    });

    it('paying out writes the REFUND payment: a cash refund is CLEARED at once and the request becomes PAID', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '60000.00');
      const r = await ask(fx, b.id, '24000.00');
      const approved = await decide(fx, r.id, 'approve', { rev: r.rev });
      // Not payable before it is approved is covered below; now pay.
      const paid = await decide(fx, r.id, 'pay', {
        rev: approved.body.rev,
        method: 'BANK_TRANSFER',
        reference: 'TRX-77',
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const dto = RefundRequestSchema.parse(paid.body);
      expect(dto).toMatchObject({ status: 'PAID', paymentStatus: 'CLEARED' });
      expect(dto.paymentId).not.toBeNull();
      const o = await ok(fx, b.id);
      const refund = o.payments.find((p) => p.id === dto.paymentId);
      expect(refund).toMatchObject({
        entryType: 'REFUND',
        method: 'BANK_TRANSFER',
        amount: '24000.00',
        status: 'CLEARED',
        reference: 'TRX-77',
        refundRequestId: r.id,
        receiptNo: null,
      });
      expect(o.summary.paidTotal).toBe('36000.00');
      expect((await getBooking(t, fx, b.id)).paidTotal).toBe('36000.00');
      expect(await auditActions(fx, r.id)).toEqual([
        'refund.request',
        'refund.approve',
        'refund.pay',
      ]);
    });

    it('a cheque refund is PENDING and the request stays APPROVED until the cheque clears; then it is PAID', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '10000.00');
      const r = await ask(fx, b.id, '4000.00');
      const approved = await decide(fx, r.id, 'approve', { rev: r.rev });
      expect(
        (await decide(fx, r.id, 'pay', { rev: approved.body.rev, method: 'CHEQUE' })).status,
      ).toBe(400); // needs the number
      const paid = await decide(fx, r.id, 'pay', {
        rev: approved.body.rev,
        method: 'CHEQUE',
        reference: 'OUT-1',
      });
      expect(paid.status).toBe(201);
      expect(paid.body).toMatchObject({ status: 'APPROVED', paymentStatus: 'PENDING' });
      expect((await ok(fx, b.id)).summary.paidTotal).toBe('10000.00');
      const cleared = await t
        .http()
        .post(`/v1/payments/${paid.body.paymentId}/clear`)
        .set(fx.accountant)
        .send({});
      expect(cleared.status).toBe(200);
      const after = await ok(fx, b.id);
      expect(after.summary.paidTotal).toBe('6000.00');
      expect(after.refundRequests[0]).toMatchObject({ status: 'PAID', paymentStatus: 'CLEARED' });
      // A refund cheque never "bounces" here.
      expect(
        (
          await t
            .http()
            .post(`/v1/payments/${paid.body.paymentId}/bounce`)
            .set(fx.accountant)
            .send({})
        ).status,
      ).toBe(422);
    });

    it('can only be paid once it is approved, only once, and never above what the customer has paid', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '10000.00');
      const r = await ask(fx, b.id, '4000.00');
      expect((await decide(fx, r.id, 'pay', { rev: r.rev, method: 'CASH' })).status).toBe(422); // still REQUESTED
      const approved = await decide(fx, r.id, 'approve', { rev: r.rev });
      const k = key();
      const first = await decide(
        fx,
        r.id,
        'pay',
        { rev: approved.body.rev, method: 'CASH' },
        fx.accountant,
        k,
      );
      expect(first.status).toBe(201);
      // The same key replays the first result.
      const replay = await decide(
        fx,
        r.id,
        'pay',
        { rev: approved.body.rev, method: 'CASH' },
        fx.accountant,
        k,
      );
      expect(replay.status).toBe(200);
      expect(replay.body.paymentId).toBe(first.body.paymentId);
      expect((await decide(fx, r.id, 'pay', { rev: first.body.rev, method: 'CASH' })).status).toBe(
        422,
      );
      expect((await ok(fx, b.id)).payments.filter((p) => p.entryType === 'REFUND')).toHaveLength(1);
      // Money taken back after the request was made leaves too little to pay out.
      const b2 = await paidBooking(fx, '10000.00');
      const r2 = await ask(fx, b2.id, '9000.00');
      const ap2 = await decide(fx, r2.id, 'approve', { rev: r2.rev });
      const receipt = (await ok(fx, b2.id)).payments[0];
      await t
        .http()
        .post(`/v1/payments/${receipt?.id}/reverse`)
        .set(fx.accountant)
        .set('Idempotency-Key', key())
        .send({ reason: 'Entered twice by mistake' });
      expect((await decide(fx, r2.id, 'pay', { rev: ap2.body.rev, method: 'CASH' })).status).toBe(
        422,
      );
    });

    it('paying needs payment.record: 403 for a sales agent; 400 without a key', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      const r = await ask(fx, b.id, '100.00');
      const approved = await decide(fx, r.id, 'approve', { rev: r.rev });
      expect(
        (await decide(fx, r.id, 'pay', { rev: approved.body.rev, method: 'CASH' }, fx.agent))
          .status,
      ).toBe(403);
      const noKey = await t
        .http()
        .post(`/v1/refund-requests/${r.id}/pay`)
        .set(fx.accountant)
        .send({ rev: approved.body.rev, method: 'CASH' });
      expect(noKey.status).toBe(400);
    });

    it('the list is a queue: newest first, filtered by status and booking, paged by cursor, only this workspace', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx, '90000.00');
      const ids: string[] = [];
      for (const amount of ['100.00', '200.00', '300.00'])
        ids.push((await ask(fx, b.id, amount)).id);
      const approved = await decide(fx, ids[0] as string, 'approve', { rev: 1 });
      expect(approved.status).toBe(200);
      const all = await t.http().get('/v1/refund-requests?limit=2').set(fx.accountant);
      expect(all.status).toBe(200);
      const page1 = RefundRequestListResponseSchema.parse(all.body);
      expect(page1.data.map((r) => r.id)).toEqual([ids[2], ids[1]]);
      expect(page1.nextCursor).not.toBeNull();
      const next = await t
        .http()
        .get(`/v1/refund-requests?limit=2&cursor=${page1.nextCursor}`)
        .set(fx.accountant);
      expect(next.body.data.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
      expect(next.body.nextCursor).toBeNull();
      const requested = await t
        .http()
        .get('/v1/refund-requests?status=REQUESTED')
        .set(fx.accountant);
      expect(requested.body.data).toHaveLength(2);
      const byBooking = await t
        .http()
        .get(`/v1/refund-requests?bookingId=${b.id}&status=APPROVED`)
        .set(fx.accountant);
      expect(byBooking.body.data.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
      expect(
        (await t.http().get('/v1/refund-requests?status=NOPE').set(fx.accountant)).status,
      ).toBe(400);
      expect((await t.http().get('/v1/refund-requests?limit=0').set(fx.accountant)).status).toBe(
        400,
      );
      expect((await t.http().get('/v1/refund-requests').set(fx.ops)).status).toBe(403);
      expect((await t.http().get('/v1/refund-requests').set(t.csrfHeaders)).status).toBe(401);
      const other = await fixture();
      expect((await t.http().get('/v1/refund-requests').set(other.accountant)).body.data).toEqual(
        [],
      );
    });

    it('the database keeps the two-person rule too: a decision by the requester must say it was a self-approval', async () => {
      const fx = await fixture();
      const b = await paidBooking(fx);
      const r = await ask(fx, b.id, '100.00');
      const bad = world.db.tx(
        { tenantId: fx.c.tenant.id },
        (tx) =>
          tx.$executeRaw`UPDATE refund_requests SET status = 'APPROVED', approved_by_id = requested_by_id, self_approved = false WHERE id = ${r.id}`,
      );
      await expect(bad).rejects.toThrow(/refund_requests_two_person_rule/);
      const half = world.db.tx(
        { tenantId: fx.c.tenant.id },
        (tx) => tx.$executeRaw`UPDATE refund_requests SET status = 'APPROVED' WHERE id = ${r.id}`,
      );
      await expect(half).rejects.toThrow(/refund_requests_decision_consistent/);
    });
  });

  // ───────────────────────────── receivables ─────────────────────────────

  describe('receivables', () => {
    it('lists confirmed bookings that still owe money, with what is due next; held, draft and fully paid ones are not there', async () => {
      const fx = await fixture();
      const owing = await confirmed(fx);
      await held(fx, quoteBody(fx, [session(fx, { date: day(3) })])); // held: not a receivable yet
      const paidUp = await confirmed(fx, quoteBody(fx, [session(fx, { date: day(5) })]));
      await record(fx, paidUp.id, cash('50000.00'));
      const res = await t.http().get('/v1/receivables').set(fx.accountant);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const list = ReceivablesResponseSchema.parse(res.body);
      expect(list.currency).toBe('PKR');
      expect(list.data.map((r) => r.bookingId)).toEqual([owing.id]);
      expect(list.data[0]).toMatchObject({
        number: owing.number,
        status: 'CONFIRMED',
        grandTotal: '100000.00',
        paidTotal: '50000.00',
        balanceDue: '50000.00',
        nextDueDate: '2030-12-25',
        nextDueAmount: '50000.00',
        overdueAmount: '0.00',
        overdueDays: null,
      });
      expect(list.data[0]?.customer.name).toBe(fx.customer.name);
    });

    it('puts overdue bookings first, the longest overdue on top; filters by venue, due dates and overdue only', async () => {
      const fx = await fixture();
      const soon = await confirmed(fx, quoteBody(fx, [session(fx, { date: day(0) })]));
      const late = await confirmed(fx, quoteBody(fx, [session(fx, { date: day(2) })]));
      const later = await confirmed(fx, quoteBody(fx, [session(fx, { date: day(4) })]));
      const put = (id: string, due: string) =>
        t
          .http()
          .put(`/v1/bookings/${id}/payment-schedule`)
          .set(fx.accountant)
          .send({
            items: [
              { label: 'Advance', dueDate: due, amount: '50000.00' },
              { label: 'Balance', dueDate: '2031-12-01', amount: '50000.00' },
            ],
          });
      // The advance of each is paid; what matters is the Balance. Make the balance overdue by different amounts.
      const putBalance = (id: string, due: string) =>
        t
          .http()
          .put(`/v1/bookings/${id}/payment-schedule`)
          .set(fx.accountant)
          .send({
            items: [
              { label: 'Advance', dueDate: '2019-01-01', amount: '50000.00' },
              { label: 'Balance', dueDate: due, amount: '50000.00' },
            ],
          });
      void put;
      expect((await putBalance(late.id, '2020-03-01')).status).toBe(200);
      expect((await putBalance(later.id, '2020-06-01')).status).toBe(200);
      const res = await t.http().get('/v1/receivables').set(fx.accountant);
      const order = res.body.data.map((r: { bookingId: string }) => r.bookingId);
      expect(order).toEqual([late.id, later.id, soon.id]);
      expect(res.body.data[0].overdueAmount).toBe('50000.00');
      expect(res.body.data[0].overdueDays).toBeGreaterThan(res.body.data[1].overdueDays);
      expect(res.body.data[2].overdueDays).toBeNull();
      const overdue = await t.http().get('/v1/receivables?overdue=true').set(fx.accountant);
      expect(overdue.body.data.map((r: { bookingId: string }) => r.bookingId)).toEqual([
        late.id,
        later.id,
      ]);
      const range = await t
        .http()
        .get('/v1/receivables?from=2030-12-01&to=2030-12-31')
        .set(fx.accountant);
      expect(range.body.data.map((r: { bookingId: string }) => r.bookingId)).toEqual([soon.id]);
      const venue = await t.http().get(`/v1/receivables?venueId=${fx.venue.id}`).set(fx.accountant);
      expect(venue.body.data).toHaveLength(3);
      const none = await t.http().get('/v1/receivables?venueId=other_venue').set(fx.accountant);
      expect(none.body.data).toEqual([]);
      const paged = await t.http().get('/v1/receivables?limit=2').set(fx.accountant);
      expect(paged.body.data).toHaveLength(2);
      const rest = await t
        .http()
        .get(`/v1/receivables?limit=2&cursor=${paged.body.nextCursor}`)
        .set(fx.accountant);
      expect(rest.body.data.map((r: { bookingId: string }) => r.bookingId)).toEqual([soon.id]);
      expect(rest.body.nextCursor).toBeNull();
    });

    it('the summary counts what is due this week, what is overdue and what is outstanding', async () => {
      const fx = await fixture();
      const overdue = await confirmed(fx);
      const week = await confirmed(fx, quoteBody(fx, [session(fx, { date: day(3) })]));
      const today = new Date().toISOString().slice(0, 10);
      const putBalance = (id: string, due: string) =>
        t
          .http()
          .put(`/v1/bookings/${id}/payment-schedule`)
          .set(fx.accountant)
          .send({
            items: [
              { label: 'Advance', dueDate: '2019-01-01', amount: '50000.00' },
              { label: 'Balance', dueDate: due, amount: '50000.00' },
            ],
          });
      await putBalance(overdue.id, '2020-03-01');
      await putBalance(week.id, today);
      const res = await t.http().get('/v1/receivables/summary').set(fx.accountant);
      expect(res.status).toBe(200);
      const s = ReceivablesSummarySchema.parse(res.body);
      expect(s.currency).toBe('PKR');
      expect(s.overdue).toEqual({ count: 1, amount: '50000.00' });
      expect(s.dueThisWeek).toEqual({ count: 1, amount: '50000.00' });
      expect(s.outstanding).toEqual({ count: 2, amount: '100000.00' });
    });

    it('is empty for a workspace without bookings; hidden from other workspaces; needs payment.view', async () => {
      const a = await fixture();
      const b = await fixture();
      await confirmed(a);
      expect((await t.http().get('/v1/receivables').set(b.accountant)).body.data).toEqual([]);
      expect(
        (await t.http().get('/v1/receivables/summary').set(b.accountant)).body.outstanding,
      ).toEqual({ count: 0, amount: '0.00' });
      expect((await t.http().get('/v1/receivables').set(a.ops)).status).toBe(403);
      expect((await t.http().get('/v1/receivables/summary').set(a.ops)).status).toBe(403);
      expect((await t.http().get('/v1/receivables').set(t.csrfHeaders)).status).toBe(401);
      expect((await t.http().get('/v1/receivables?from=bad').set(a.accountant)).status).toBe(400);
      expect((await t.http().get('/v1/receivables?limit=1000').set(a.accountant)).status).toBe(400);
      expect((await t.http().get('/v1/receivables?cursor=zzz').set(a.accountant)).status).toBe(400);
    });

    it('a refund or a reversal lowers what has been paid and so raises what is owed', async () => {
      const fx = await fixture();
      const c = await confirmed(fx);
      const first = (await ok(fx, c.id)).payments[0];
      await t
        .http()
        .post(`/v1/payments/${first?.id}/reverse`)
        .set(fx.accountant)
        .set('Idempotency-Key', key())
        .send({ reason: 'Entered on the wrong booking' });
      const res = await t.http().get('/v1/receivables').set(fx.accountant);
      expect(res.body.data[0]).toMatchObject({ paidTotal: '0.00', balanceDue: '100000.00' });
    });
  });
  describe('the booking history', () => {
    it('holds the money steps for those who may see payments, with their reasons; others see the booking only', async () => {
      const fx = await fixture();
      const b = await held(fx);
      const p = PaymentSchema.parse((await record(fx, b.id, cash('1000.00'))).body);
      await t
        .http()
        .post(`/v1/payments/${p.id}/reverse`)
        .set(fx.accountant)
        .set('Idempotency-Key', key())
        .send({ reason: 'Entered on the wrong booking' });
      const asked = await t
        .http()
        .post(`/v1/bookings/${b.id}/refund-requests`)
        .set(fx.manager)
        .set('Idempotency-Key', key())
        .send({ amount: '1.00', reason: 'x' });
      expect(asked.status).toBe(400); // the reason is too short: nothing is audited for it
      const withMoney = await t.http().get(`/v1/bookings/${b.id}`).set(fx.accountant);
      const actions = withMoney.body.timeline.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'booking.hold',
          'payment.record',
          'payment.reverse',
          'payment_schedule.generate',
        ]),
      );
      const reversal = withMoney.body.timeline.find(
        (e: { action: string }) => e.action === 'payment.reverse',
      );
      expect(reversal.reason).toBe('Entered on the wrong booking');
      // Operations may see the booking but not payments: no money lines in its history.
      const plain = await t.http().get(`/v1/bookings/${b.id}`).set(fx.ops);
      expect(plain.status).toBe(200);
      const plainActions = plain.body.timeline.map((e: { action: string }) => e.action);
      expect(plainActions).toContain('booking.hold');
      expect(
        plainActions.some((a: string) => a.startsWith('payment.') || a.startsWith('refund.')),
      ).toBe(false);
    });
  });
});
