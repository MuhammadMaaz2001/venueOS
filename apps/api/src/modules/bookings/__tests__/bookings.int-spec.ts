import { BookingDetailSchema, BookingListResponseSchema } from '@venueos/shared';
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

// Module 8: bookings. The life of a booking (hold, extend, confirm, cancel, restore, re-hold), what the database guards (two
// holds on one slot, combined spaces, buffers), the venue rules, the advance, changes and re-quoting, hidden prices, scoping.

describe('bookings endpoints', () => {
  let t: TestApp;
  let world: World;

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const post = (fx: BookingWorld, path: string, body: object, auth = fx.c.auth) =>
    t.http().post(path).set(auth).send(body);
  const patch = (fx: BookingWorld, path: string, body: object, auth = fx.c.auth) =>
    t.http().patch(path).set(auth).send(body);
  const hold = (
    fx: BookingWorld,
    b: { id: string; rev: number },
    extra: object = {},
    auth = fx.c.auth,
  ) => post(fx, `/v1/bookings/${b.id}/hold`, { rev: b.rev, ...extra }, auth);
  /** A draft booking (not held). */
  const draft = async (fx: BookingWorld, body: object = quoteBody(fx), auth = fx.c.auth) => {
    const q = await createQuotation(t, fx, body, auth);
    return getBooking(t, fx, q.bookingId, auth);
  };
  const pay = (
    fx: BookingWorld,
    bookingId: string,
    amount: string,
    over: Record<string, unknown> = {},
  ) =>
    world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
      tx.payment.create({
        data: {
          tenantId: fx.c.tenant.id,
          bookingId,
          method: 'CASH',
          amount,
          status: 'CLEARED',
          entryType: 'RECEIPT',
          ...over,
        } as never,
      }),
    );
  const occupancies = (fx: BookingWorld, bookingId: string) =>
    world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
      tx.spaceOccupancy.findMany({
        where: { session: { bookingId } },
        orderBy: { startsAt: 'asc' },
      }),
    );
  const setStatus = (fx: BookingWorld, bookingId: string, status: 'EXPIRED' | 'TENTATIVE') =>
    world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
      tx.booking.updateMany({ where: { id: bookingId }, data: { status } }),
    );

  describe('hold', () => {
    it('200: DRAFT -> TENTATIVE, numbered, with a hold timer, the calendar blocked and the policy copied', async () => {
      const fx = await bookingWorld(t, world);
      const b = await draft(fx);
      expect(b).toMatchObject({ status: 'DRAFT', number: null, holdExpiresAt: null });
      const res = await hold(fx, b);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const held = BookingDetailSchema.parse(res.body);
      expect(held.status).toBe('TENTATIVE');
      expect(held.number).toMatch(/^BK-\d{4}-0001$/);
      const hours = (new Date(held.holdExpiresAt as string).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(47.9);
      expect(hours).toBeLessThan(48.1);
      expect(held.cancellationPolicy).toMatchObject({ name: 'Standard' });
      expect(held.cancellationPolicy?.tiers).toHaveLength(3);
      expect(held.timeline.map((e) => e.action)).toContain('booking.hold');
      const rows = await occupancies(fx, b.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ active: true });
      // The number is not reused: the next held booking is 0002, and a cancelled one keeps its number.
      const second = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(1) })]));
      expect(second.number).toMatch(/-0002$/);
      expect(
        await world.auditRows(fx.c.tenant, { action: 'booking.hold', entityId: b.id }),
      ).toHaveLength(1);
    });

    it('409 SLOT_TAKEN when the slot is held; another space or another day is fine; a draft never blocks', async () => {
      const fx = await bookingWorld(t, world);
      await heldBooking(t, fx);
      const same = await draft(fx);
      const res = await hold(fx, same);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('SLOT_TAKEN');
      expect((await getBooking(t, fx, same.id)).status).toBe('DRAFT'); // rolled back
      expect(await occupancies(fx, same.id)).toEqual([]);
      const otherSpace = await draft(fx, quoteBody(fx, [session(fx, { spaceId: fx.hallB.id })]));
      expect((await hold(fx, otherSpace)).status).toBe(200);
      const otherDay = await draft(fx, quoteBody(fx, [session(fx, { date: day(1) })]));
      expect((await hold(fx, otherDay)).status).toBe(200);
      // Two drafts for the same slot do not collide with each other.
      await draft(fx, quoteBody(fx, [session(fx, { date: day(7) })]));
      await draft(fx, quoteBody(fx, [session(fx, { date: day(7) })]));
    });

    it('two concurrent holds on the same slot: exactly one wins, the other is 409 SLOT_TAKEN', async () => {
      const fx = await bookingWorld(t, world);
      for (let round = 0; round < 3; round++) {
        const date = day(20 + round);
        const a = await draft(fx, quoteBody(fx, [session(fx, { date })]));
        const b = await draft(fx, quoteBody(fx, [session(fx, { date })]));
        const results = await Promise.all([hold(fx, a), hold(fx, b)]);
        expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)?.body.error.code).toBe('SLOT_TAKEN');
        const winners = [a, b].filter((_, i) => results[i]?.status === 200);
        expect(winners).toHaveLength(1);
        const statuses = await Promise.all(
          [a, b].map(async (x) => (await getBooking(t, fx, x.id)).status),
        );
        expect(statuses.sort()).toEqual(['DRAFT', 'TENTATIVE']);
      }
    });

    it('a combined space blocks its components, and a component blocks the combined space', async () => {
      const fx = await bookingWorld(t, world);
      const combined = await draft(fx, quoteBody(fx, [session(fx, { spaceId: fx.hallAB.id })]));
      expect((await hold(fx, combined)).status).toBe(200);
      const rows = await occupancies(fx, combined.id);
      expect(rows.map((r) => r.spaceId).sort()).toEqual([fx.hallA.id, fx.hallB.id].sort());
      for (const space of [fx.hallA, fx.hallB]) {
        const b = await draft(fx, quoteBody(fx, [session(fx, { spaceId: space.id })]));
        const res = await hold(fx, b);
        expect(res.status, space.id).toBe(409);
        expect(code(res)).toBe('SLOT_TAKEN');
      }
      // The other way round: Hall A held, then the combined hall on the same evening is refused; the lunch slot is free.
      const fx2 = await bookingWorld(t, world);
      await heldBooking(t, fx2, quoteBody(fx2, [session(fx2, { spaceId: fx2.hallA.id })]));
      const ab = await draft(fx2, quoteBody(fx2, [session(fx2, { spaceId: fx2.hallAB.id })]));
      expect((await hold(fx2, ab)).status).toBe(409);
      const lunchAB = await draft(
        fx2,
        quoteBody(fx2, [session(fx2, { spaceId: fx2.hallAB.id, slotId: fx2.lunch.id })]),
      );
      expect((await hold(fx2, lunchAB)).status).toBe(200);
      // Hall B alone stays free beside Hall A.
      const b = await draft(
        fx2,
        quoteBody(fx2, [
          session(fx2, { spaceId: fx2.hallB.id, date: day(0), slotId: fx2.dinner.id }),
        ]),
      );
      expect((await hold(fx2, b)).status).toBe(200);
    });

    it('setup and cleanup buffers are blocked too: back-to-back sessions may touch, not overlap', async () => {
      const touching = await bookingWorld(t, world, { cleanupBufferMin: 180 });
      const lunchHeld = await heldBooking(
        t,
        touching,
        quoteBody(touching, [session(touching, { slotId: touching.lunch.id })]),
      );
      const rows = await occupancies(touching, lunchHeld.id);
      // Lunch 12:00-16:00 (Karachi) with 180 min cleanup blocks until 19:00; the dinner starts at 19:00.
      expect(rows[0]?.endsAt.getTime()).toBe(new Date(`${day(0)}T14:00:00Z`).getTime());
      const dinner = await draft(touching, quoteBody(touching, [session(touching)]));
      expect((await hold(touching, dinner)).status).toBe(200);

      const overlapping = await bookingWorld(t, world, { cleanupBufferMin: 240 });
      await heldBooking(
        t,
        overlapping,
        quoteBody(overlapping, [session(overlapping, { slotId: overlapping.lunch.id })]),
      );
      const clash = await draft(overlapping, quoteBody(overlapping, [session(overlapping)]));
      const res = await hold(overlapping, clash);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('SLOT_TAKEN');
    });

    it('venue rules: 422 LOCAL_RULE; overriding needs booking.override_rules AND a reason, and is audited', async () => {
      const fx = await bookingWorld(t, world, { localRules: { latestEndTime: '22:00' } });
      const b = await draft(fx);
      const refused = await hold(fx, b);
      expect(refused.status).toBe(422);
      expect(code(refused)).toBe('LOCAL_RULE');
      expect(refused.body.error.details.breaches).toEqual([
        { sessionIndex: 0, breach: 'LATEST_END_TIME' },
      ]);
      expect((await getBooking(t, fx, b.id)).status).toBe('DRAFT');
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const noRight = await hold(
        fx,
        b,
        { overrideRules: true, reason: 'The family insists' },
        memberAuth(t, agent, fx.c),
      );
      expect(noRight.status).toBe(403);
      const noReason = await hold(fx, b, { overrideRules: true });
      expect(noReason.status).toBe(400);
      const ok = await hold(fx, b, { overrideRules: true, reason: 'The family insists' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const rows = await world.auditRows(fx.c.tenant, { action: 'booking.hold', entityId: b.id });
      expect(JSON.stringify(rows[0]?.after)).toContain('The family insists');
      expect(
        ok.body.timeline.find((e: { action: string }) => e.action === 'booking.hold').reason,
      ).toBe('The family insists');

      const guests = await bookingWorld(t, world, { localRules: { maxGuests: 300 } });
      const big = await draft(guests, quoteBody(guests, [session(guests, { guests: 301 })]));
      expect(code(await hold(guests, big))).toBe('LOCAL_RULE');
      const fine = await draft(
        guests,
        quoteBody(guests, [session(guests, { date: day(2), guests: 300 })]),
      );
      expect((await hold(guests, fine)).status).toBe(200);
    });

    it('422 from any other status; 409 on a stale rev; 400 without rev; 401 / 403', async () => {
      const fx = await bookingWorld(t, world);
      const held = await heldBooking(t, fx);
      const again = await hold(fx, held);
      expect(again.status).toBe(422);
      expect(code(again)).toBe('INVALID_STATE_TRANSITION');
      const b = await draft(fx, quoteBody(fx, [session(fx, { date: day(3) })]));
      expect(code(await hold(fx, { id: b.id, rev: b.rev + 5 }))).toBe('VERSION_CONFLICT');
      expect((await post(fx, `/v1/bookings/${b.id}/hold`, {})).status).toBe(400);
      expect(
        (await t.http().post(`/v1/bookings/${b.id}/hold`).set(t.csrfHeaders).send({ rev: 1 }))
          .status,
      ).toBe(401);
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      expect((await hold(fx, b, {}, memberAuth(t, accountant, fx.c))).status).toBe(403);
    });
  });

  describe('extend hold', () => {
    it('once for anyone who may hold; more extensions need booking.extend_hold; only a TENTATIVE booking', async () => {
      const fx = await bookingWorld(t, world);
      const holder = await world.addMember(fx.c.tenant, {
        role: {
          permissions: [
            'venue.view',
            'booking.view',
            'booking.view_prices',
            'booking.create',
            'booking.hold',
            'quotation.manage',
          ],
        },
      });
      const auth = memberAuth(t, holder, fx.c);
      const b = await heldBooking(t, fx, quoteBody(fx), auth);
      const before = new Date(b.holdExpiresAt).getTime();
      const first = await post(fx, `/v1/bookings/${b.id}/extend-hold`, { rev: b.rev }, auth);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.holdExtensions).toBe(1);
      expect(new Date(first.body.holdExpiresAt).getTime() - before).toBe(48 * 3_600_000);
      const second = await post(
        fx,
        `/v1/bookings/${b.id}/extend-hold`,
        { rev: first.body.rev },
        auth,
      );
      expect(second.status).toBe(403);
      const owner = await post(fx, `/v1/bookings/${b.id}/extend-hold`, { rev: first.body.rev });
      expect(owner.status).toBe(200);
      expect(owner.body.holdExtensions).toBe(2);
      const d = await draft(fx, quoteBody(fx, [session(fx, { date: day(4) })]));
      expect((await post(fx, `/v1/bookings/${d.id}/extend-hold`, { rev: d.rev })).status).toBe(422);
    });
  });

  describe('confirm', () => {
    it('422 ADVANCE_REQUIRED without the advance, with the amounts; the lead stays open', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const res = await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: b.rev });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('ADVANCE_REQUIRED');
      expect(res.body.error.details).toEqual({
        advancePct: 50,
        required: '50000.00',
        received: '0.00',
      });
      expect((await getBooking(t, fx, b.id)).status).toBe('TENTATIVE');
    });

    it('confirms when cleared receipts reach the advance; a pending or bounced cheque never counts', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      await pay(fx, b.id, '60000', { method: 'CHEQUE', status: 'PENDING' });
      await pay(fx, b.id, '60000', { method: 'CHEQUE', status: 'BOUNCED' });
      expect(code(await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: b.rev }))).toBe(
        'ADVANCE_REQUIRED',
      );
      await pay(fx, b.id, '49999.99');
      expect(code(await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: b.rev }))).toBe(
        'ADVANCE_REQUIRED',
      );
      await pay(fx, b.id, '0.01');
      const ok = await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: b.rev });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
      expect(ok.body.confirmedAt).not.toBeNull();
      expect(await occupancies(fx, b.id)).toHaveLength(1);
      expect((await occupancies(fx, b.id))[0]?.active).toBe(true);
    });

    it('override: needs booking.confirm_override and a reason, is audited, and the lead becomes WON', async () => {
      const fx = await bookingWorld(t, world);
      const lead = await t
        .http()
        .post('/v1/leads')
        .set(fx.c.auth)
        .send({
          venueId: fx.venue.id,
          customerId: fx.customer.id,
          source: 'walk_in',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      const q = await createQuotation(t, fx, {
        ...quoteBody(fx),
        customerId: undefined,
        leadId: lead.body.id,
      });
      expect((await t.http().get(`/v1/leads/${lead.body.id}`).set(fx.c.auth)).body.stage).toBe(
        'QUOTED',
      );
      const draftBooking = await getBooking(t, fx, q.bookingId);
      const held = (await hold(fx, draftBooking)).body;
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const noRight = await post(
        fx,
        `/v1/bookings/${held.id}/confirm`,
        { rev: held.rev, override: true, reason: 'Trusted family' },
        memberAuth(t, agent, fx.c),
      );
      expect(noRight.status).toBe(403);
      expect(
        (await post(fx, `/v1/bookings/${held.id}/confirm`, { rev: held.rev, override: true }))
          .status,
      ).toBe(400);
      const ok = await post(fx, `/v1/bookings/${held.id}/confirm`, {
        rev: held.rev,
        override: true,
        reason: 'Trusted family',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('CONFIRMED');
      const rows = await world.auditRows(fx.c.tenant, {
        action: 'booking.confirm',
        entityId: held.id,
      });
      expect(rows[0]?.after).toMatchObject({
        override: true,
        reason: 'Trusted family',
        advanceMet: false,
      });
      expect(
        ok.body.timeline.find((e: { action: string }) => e.action === 'booking.confirm').reason,
      ).toBe('Trusted family');
      const wonLead = (await t.http().get(`/v1/leads/${lead.body.id}`).set(fx.c.auth)).body;
      expect(wonLead).toMatchObject({ stage: 'WON', nextFollowUpAt: null });
    });

    it('an override without need is just a confirmation; confirming a draft or a confirmed booking is 422', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      await pay(fx, b.id, '100000');
      const ok = await post(fx, `/v1/bookings/${b.id}/confirm`, {
        rev: b.rev,
        override: true,
        reason: 'not needed',
      });
      expect(ok.status).toBe(200);
      expect(code(await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: ok.body.rev }))).toBe(
        'INVALID_STATE_TRANSITION',
      );
      const d = await draft(fx, quoteBody(fx, [session(fx, { date: day(9) })]));
      expect(code(await post(fx, `/v1/bookings/${d.id}/confirm`, { rev: d.rev }))).toBe(
        'INVALID_STATE_TRANSITION',
      );
    });

    it('the cancellation policy is copied at confirmation: later edits of the policy never change the booking', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const policies = (await t.http().get('/v1/cancellation-policies').set(fx.c.auth)).body.data;
      await patch(fx, `/v1/cancellation-policies/${policies[0].id}`, {
        rev: policies[0].rev,
        tiers: [{ minDaysBefore: 0, refundPct: 100 }],
      });
      const ok = await post(fx, `/v1/bookings/${b.id}/confirm`, {
        rev: b.rev,
        override: true,
        reason: 'test',
      });
      expect(ok.body.cancellationPolicy.tiers).toEqual([{ minDaysBefore: 0, refundPct: 100 }]); // copied now
      await patch(fx, `/v1/cancellation-policies/${policies[0].id}`, {
        rev: policies[0].rev + 1,
        tiers: [{ minDaysBefore: 0, refundPct: 0 }],
      });
      expect((await getBooking(t, fx, b.id)).cancellationPolicy.tiers).toEqual([
        { minDaysBefore: 0, refundPct: 100 },
      ]);
    });
  });

  describe('cancel, restore, re-hold', () => {
    it('cancel needs a reason, frees the slot, suggests the refund of the policy snapshot, and keeps the number', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      await pay(fx, b.id, '100000');
      const confirmed = (await post(fx, `/v1/bookings/${b.id}/confirm`, { rev: b.rev })).body;
      expect((await post(fx, `/v1/bookings/${b.id}/cancel`, { rev: confirmed.rev })).status).toBe(
        400,
      );
      expect(
        (await post(fx, `/v1/bookings/${b.id}/cancel`, { rev: confirmed.rev, reason: 'x' })).status,
      ).toBe(400);
      const res = await post(fx, `/v1/bookings/${b.id}/cancel`, {
        rev: confirmed.rev,
        reason: 'The family moved abroad',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        number: b.number,
        cancelReason: 'The family moved abroad',
        suggestedRefund: '80000.00',
      });
      expect(res.body.refund).toMatchObject({
        refundPct: 80,
        received: '100000.00',
        suggested: '80000.00',
      });
      expect(res.body.refund.daysBefore).toBeGreaterThan(60);
      expect((await occupancies(fx, b.id))[0]?.active).toBe(false);
      // The slot is free again.
      const next = await draft(fx);
      expect((await hold(fx, next)).status).toBe(200);
      expect(
        code(
          await post(fx, `/v1/bookings/${b.id}/cancel`, {
            rev: res.body.rev,
            reason: 'again please',
          }),
        ),
      ).toBe('INVALID_STATE_TRANSITION');
      expect(
        await world.auditRows(fx.c.tenant, { action: 'booking.cancel', entityId: b.id }),
      ).toHaveLength(1);
    });

    it('a quotation can be cancelled (no refund); a hold with nothing paid suggests 0', async () => {
      const fx = await bookingWorld(t, world);
      const d = await draft(fx);
      const cancelledDraft = await post(fx, `/v1/bookings/${d.id}/cancel`, {
        rev: d.rev,
        reason: 'Customer went elsewhere',
      });
      expect(cancelledDraft.body).toMatchObject({
        status: 'CANCELLED',
        number: null,
        refund: null,
      });
      const h = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(3) })]));
      const res = await post(fx, `/v1/bookings/${h.id}/cancel`, {
        rev: h.rev,
        reason: 'Changed their mind',
      });
      expect(res.body.refund).toMatchObject({ refundPct: 80, suggested: '0.00' });
      expect(res.body.holdExpiresAt).toBeNull();
    });

    it('a cancelled draft restores to a draft; a cancelled hold restores with a fresh timer', async () => {
      const fx = await bookingWorld(t, world);
      const d = await draft(fx);
      const c1 = await post(fx, `/v1/bookings/${d.id}/cancel`, {
        rev: d.rev,
        reason: 'Wrong customer',
      });
      const r1 = await post(fx, `/v1/bookings/${d.id}/restore`, { rev: c1.body.rev });
      expect(r1.status).toBe(200);
      expect(r1.body).toMatchObject({ status: 'DRAFT', cancelReason: null, cancelledAt: null });
      const h = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(3) })]));
      const c2 = await post(fx, `/v1/bookings/${h.id}/cancel`, { rev: h.rev, reason: 'Oops' });
      const r2 = await post(fx, `/v1/bookings/${h.id}/restore`, { rev: c2.body.rev });
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(r2.body.status).toBe('TENTATIVE');
      expect(r2.body.number).toBe(h.number);
      expect(new Date(r2.body.holdExpiresAt).getTime()).toBeGreaterThan(
        Date.now() + 47 * 3_600_000,
      );
      expect((await occupancies(fx, h.id))[0]?.active).toBe(true);
      expect(code(await post(fx, `/v1/bookings/${h.id}/restore`, { rev: r2.body.rev }))).toBe(
        'INVALID_STATE_TRANSITION',
      );
    });

    it('restore fails with 409 SLOT_TAKEN when somebody took the slot, and works once it is free again', async () => {
      const fx = await bookingWorld(t, world);
      const first = await heldBooking(t, fx);
      const cancelled = (
        await post(fx, `/v1/bookings/${first.id}/cancel`, {
          rev: first.rev,
          reason: 'Changed mind',
        })
      ).body;
      const second = await heldBooking(t, fx); // takes the slot
      const refused = await post(fx, `/v1/bookings/${first.id}/restore`, { rev: cancelled.rev });
      expect(refused.status).toBe(409);
      expect(code(refused)).toBe('SLOT_TAKEN');
      expect((await getBooking(t, fx, first.id)).status).toBe('CANCELLED');
      await post(fx, `/v1/bookings/${second.id}/cancel`, { rev: second.rev, reason: 'Gave it up' });
      expect(
        (await post(fx, `/v1/bookings/${first.id}/restore`, { rev: cancelled.rev })).status,
      ).toBe(200);
    });

    it('an expired hold can be re-held; 409 when the slot was taken meanwhile; EXPIRED frees the slot', async () => {
      const fx = await bookingWorld(t, world);
      const a = await heldBooking(t, fx);
      await setStatus(fx, a.id, 'EXPIRED'); // what the holds.expire job does
      expect((await occupancies(fx, a.id))[0]?.active).toBe(false);
      const expired = await getBooking(t, fx, a.id);
      expect(expired.status).toBe('EXPIRED');
      const re = await post(fx, `/v1/bookings/${a.id}/rehold`, { rev: expired.rev });
      expect(re.status, JSON.stringify(re.body)).toBe(200);
      expect(re.body.status).toBe('TENTATIVE');
      expect(re.body.holdExtensions).toBe(0);

      await setStatus(fx, a.id, 'EXPIRED');
      await heldBooking(t, fx); // somebody else takes the slot
      const refused = await post(fx, `/v1/bookings/${a.id}/rehold`, {
        rev: (await getBooking(t, fx, a.id)).rev,
      });
      expect(refused.status).toBe(409);
      expect(code(refused)).toBe('SLOT_TAKEN');
      const d = await draft(fx, quoteBody(fx, [session(fx, { date: day(8) })]));
      expect(code(await post(fx, `/v1/bookings/${d.id}/rehold`, { rev: d.rev }))).toBe(
        'INVALID_STATE_TRANSITION',
      );
    });

    it('cancel and restore need booking.cancel: a sales agent may not', async () => {
      const fx = await bookingWorld(t, world);
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const b = await heldBooking(t, fx);
      expect(
        (
          await post(
            fx,
            `/v1/bookings/${b.id}/cancel`,
            { rev: b.rev, reason: 'No right' },
            memberAuth(t, agent, fx.c),
          )
        ).status,
      ).toBe(403);
      const manager = await world.addMember(fx.c.tenant, { role: 'branch_manager' });
      expect(
        (
          await post(
            fx,
            `/v1/bookings/${b.id}/cancel`,
            { rev: b.rev, reason: 'Manager decision' },
            memberAuth(t, manager, fx.c),
          )
        ).status,
      ).toBe(200);
    });
  });

  describe('changes and re-quoting (docs/05 sections 2 and 4)', () => {
    const withPackage = (fx: BookingWorld, guests = 200, over: Record<string, unknown> = {}) =>
      quoteBody(fx, [session(fx, { guests, packageId: fx.pkg.id, ...over })]);
    const sessionId = (b: { sessions: { id: string }[] }) => b.sessions[0]?.id as string;

    it('a held booking is re-priced at its FROZEN rates; requote CURRENT uses today catalogue; each change is a new version', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx, withPackage(fx));
      expect(b.totals.grandTotal).toBe('400000.00'); // 100000 + 1500 x 200
      const pkg = (await t.http().get('/v1/packages').set(fx.c.auth)).body.data[0];
      await patch(fx, `/v1/packages/${pkg.id}`, { rev: pkg.rev, perHeadRate: '2000' });

      const frozen = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: b.rev,
        guests: 300,
      });
      expect(frozen.status, JSON.stringify(frozen.body)).toBe(200);
      expect(frozen.body.totals.grandTotal).toBe('550000.00'); // 100000 + 1500 (frozen) x 300
      expect(frozen.body.quoteVersion).toBe(2);
      expect(frozen.body.quotations.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(frozen.body.status).toBe('TENTATIVE');

      const current = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: frozen.body.rev,
        requote: 'CURRENT',
        guests: 300,
      });
      expect(current.status).toBe(200);
      expect(current.body.totals.grandTotal).toBe('700000.00'); // 100000 + 2000 x 300
      expect(current.body.quoteVersion).toBe(3);
      // Version 1 still shows what the customer first saw.
      const v1 = current.body.quotations.find((v: { version: number }) => v.version === 1);
      expect(
        (await t.http().get(`/v1/quotations/${v1.id}`).set(fx.c.auth)).body.totals.grandTotal,
      ).toBe('400000.00');
      const rows = await world.auditRows(fx.c.tenant, {
        action: 'booking.session.update',
        entityId: b.id,
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.before).toMatchObject({ grandTotal: '400000' });
    });

    it('guests below the guarantee never reduce the bill; above it the bill grows', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx, withPackage(fx, 200, { guaranteedGuests: 250 }));
      expect(b.totals.grandTotal).toBe('475000.00'); // billed on 250
      expect(b.sessions[0]).toMatchObject({
        billedGuests: 250,
        guests: 200,
        guaranteedGuests: 250,
      });
      const fewer = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: b.rev,
        guests: 50,
      });
      expect(fewer.body.totals.grandTotal).toBe('475000.00');
      expect(fewer.body.sessions[0]).toMatchObject({ guests: 50, billedGuests: 250 });
      const more = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: fewer.body.rev,
        guests: 300,
      });
      expect(more.body.totals.grandTotal).toBe('550000.00');
    });

    it('inside the guest lock window changes need booking.edit_locked (a branch manager has it, a sales agent does not)', async () => {
      const fx = await bookingWorld(t, world);
      const soon = new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10);
      const b = await heldBooking(t, fx, withPackage(fx, 200, { date: soon }));
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const denied = await patch(
        fx,
        `/v1/bookings/${b.id}/sessions/${sessionId(b)}`,
        { rev: b.rev, guests: 250 },
        memberAuth(t, agent, fx.c),
      );
      expect(denied.status).toBe(403);
      const manager = await world.addMember(fx.c.tenant, { role: 'branch_manager' });
      const ok = await patch(
        fx,
        `/v1/bookings/${b.id}/sessions/${sessionId(b)}`,
        { rev: b.rev, guests: 250 },
        memberAuth(t, manager, fx.c),
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      // A session far away is not locked for the agent.
      const far = await heldBooking(t, fx, withPackage(fx, 200, { date: day(40) }));
      const free = await patch(
        fx,
        `/v1/bookings/${far.id}/sessions/${sessionId(far)}`,
        { rev: far.rev, guests: 250 },
        memberAuth(t, agent, fx.c),
      );
      expect(free.status).toBe(200);
      // A draft is never locked.
      const d = await draft(
        fx,
        withPackage(fx, 200, {
          date: new Date(Date.now() + 36 * 3_600_000 + 86_400_000 * 3).toISOString().slice(0, 10),
        }),
      );
      expect(
        (
          await patch(
            fx,
            `/v1/bookings/${d.id}`,
            { rev: d.rev, notes: 'x' },
            memberAuth(t, agent, fx.c),
          )
        ).status,
      ).toBe(200);
    });

    it('new dates move the calendar block; a taken slot is 409 and changes nothing; the old slot is freed', async () => {
      const fx = await bookingWorld(t, world);
      const a = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(0) })]));
      const b = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(1) })]));
      const clash = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: b.rev,
        date: day(0),
      });
      expect(clash.status).toBe(409);
      expect(code(clash)).toBe('SLOT_TAKEN');
      const unchanged = await getBooking(t, fx, b.id);
      expect(unchanged.quoteVersion).toBe(1);
      expect(unchanged.sessions[0].date).toBe(day(1));
      const moved = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: b.rev,
        date: day(2),
      });
      expect(moved.status).toBe(200);
      expect(moved.body.sessions[0].date).toBe(day(2));
      const rows = await occupancies(fx, b.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.startsAt.toISOString().slice(0, 10)).toBe(day(2));
      // day(1) is free now.
      const d = await draft(fx, quoteBody(fx, [session(fx, { date: day(1) })]));
      expect((await hold(fx, d)).status).toBe(200);
      void a;
    });

    it('add a session (priced, calendar blocked) and cancel one (soft, slot freed, last one refused)', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx, withPackage(fx, 200));
      const added = await post(fx, `/v1/bookings/${b.id}/sessions`, {
        rev: b.rev,
        session: session(fx, {
          date: day(1),
          eventTypeId: fx.mehndi.id,
          guests: 100,
          addOns: [{ addOnId: fx.addOns.fixed }],
        }),
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(added.body.sessions).toHaveLength(2);
      expect(added.body.totals.grandTotal).toBe('505000.00'); // 400000 + 100000 + 5000
      expect(added.body.quoteVersion).toBe(2);
      expect(await occupancies(fx, b.id)).toHaveLength(2);
      const second = added.body.sessions.find((s: { date: string }) => s.date === day(1));
      const cancelled = await post(fx, `/v1/bookings/${b.id}/sessions/${second.id}/cancel`, {
        rev: added.body.rev,
        reason: 'Mehndi dropped',
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(cancelled.body.sessions.map((s: { status: string }) => s.status).sort()).toEqual([
        'ACTIVE',
        'CANCELLED',
      ]);
      expect(cancelled.body.totals.grandTotal).toBe('400000.00');
      expect(cancelled.body.quoteVersion).toBe(3);
      const rows = await occupancies(fx, b.id);
      expect(rows.filter((r) => r.active)).toHaveLength(1);
      const last = cancelled.body.sessions.find((s: { status: string }) => s.status === 'ACTIVE');
      const refused = await post(fx, `/v1/bookings/${b.id}/sessions/${last.id}/cancel`, {
        rev: cancelled.body.rev,
      });
      expect(refused.status).toBe(422);
      // The cancelled session's slot is free.
      const d = await draft(fx, quoteBody(fx, [session(fx, { date: day(1) })]));
      expect((await hold(fx, d)).status).toBe(200);
    });

    it('discount: above the role limit 403 DISCOUNT_LIMIT, within it a new version; a discount someone else gave survives re-pricing', async () => {
      const fx = await bookingWorld(t, world);
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const auth = memberAuth(t, agent, fx.c);
      const b = await heldBooking(
        t,
        fx,
        quoteBody(fx, [session(fx, { guests: 200 })], {
          discount: { type: 'PERCENT', value: '15' },
        }),
      );
      expect(b.totals.grandTotal).toBe('85000.00');
      const over = await patch(
        fx,
        `/v1/bookings/${b.id}`,
        { rev: b.rev, discount: { type: 'PERCENT', value: '6' } },
        auth,
      );
      expect(over.status).toBe(403);
      expect(code(over)).toBe('DISCOUNT_LIMIT');
      // The agent changes guests on a booking carrying the owner's 15%: it stays (the cap applies to NEW discounts only).
      const edit = await patch(
        fx,
        `/v1/bookings/${b.id}/sessions/${sessionId(b)}`,
        { rev: b.rev, guests: 220, addOns: [{ addOnId: fx.addOns.fixed }] },
        auth,
      );
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      expect(edit.body.totals.grandTotal).toBe('89250.00'); // (100000 + 5000) x 85%
      expect(edit.body.discount).toEqual({ type: 'PERCENT', value: '15' });
      const ok = await patch(
        fx,
        `/v1/bookings/${b.id}`,
        { rev: edit.body.rev, discount: { type: 'PERCENT', value: '5' } },
        auth,
      );
      expect(ok.status).toBe(200);
      expect(ok.body.totals.grandTotal).toBe('99750.00');
      expect(ok.body.quoteVersion).toBe(3);
      const removed = await patch(fx, `/v1/bookings/${b.id}`, { rev: ok.body.rev, discount: null });
      expect(removed.body.totals.discountTotal).toBe('0.00');
      expect(removed.body.quoteVersion).toBe(4);
    });

    it('notes and policy change without a new version; sessions can only be replaced on a draft; closed bookings are frozen', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const noted = await patch(fx, `/v1/bookings/${b.id}`, {
        rev: b.rev,
        notes: 'Bride prefers the left entrance',
      });
      expect(noted.body).toMatchObject({
        notes: 'Bride prefers the left entrance',
        quoteVersion: 1,
      });
      expect(
        (await patch(fx, `/v1/bookings/${b.id}`, { rev: noted.body.rev, sessions: [session(fx)] }))
          .status,
      ).toBe(422);
      expect((await patch(fx, `/v1/bookings/${b.id}`, { rev: noted.body.rev })).status).toBe(400);
      const cancelled = await post(fx, `/v1/bookings/${b.id}/cancel`, {
        rev: noted.body.rev,
        reason: 'Closed for the test',
      });
      expect(
        (await patch(fx, `/v1/bookings/${b.id}`, { rev: cancelled.body.rev, notes: 'late' }))
          .status,
      ).toBe(422);
      expect(
        code(
          await post(fx, `/v1/bookings/${b.id}/sessions`, {
            rev: cancelled.body.rev,
            session: session(fx),
          }),
        ),
      ).toBe('INVALID_STATE_TRANSITION');
    });

    it('tax stays at the rate the booking was quoted with (frozen), until re-quoted at current rates', async () => {
      const fx = await bookingWorld(t, world, { tax: { ratePct: '16', inclusive: false } });
      const b = await heldBooking(t, fx);
      expect(b.totals.grandTotal).toBe('116000.00');
      const tax = (await t.http().get('/v1/tax-rates').set(fx.c.auth)).body.data[0];
      await patch(fx, `/v1/tax-rates/${tax.id}`, { rev: tax.rev, ratePct: '20' });
      const edit = await patch(fx, `/v1/bookings/${b.id}/sessions/${sessionId(b)}`, {
        rev: b.rev,
        guests: 210,
      });
      expect(edit.body.totals.grandTotal).toBe('116000.00');
      expect(edit.body.taxRate).toMatchObject({ ratePct: '16' });
      const fresh = await patch(fx, `/v1/bookings/${b.id}`, {
        rev: edit.body.rev,
        requote: 'CURRENT',
      });
      expect(fresh.body.totals.grandTotal).toBe('120000.00');
      expect(fresh.body.taxRate).toMatchObject({ ratePct: '20' });
    });
  });

  describe('GET /v1/bookings', () => {
    it('200: lists newest first, filters by status, venue, customer, date range and search, paginates', async () => {
      const fx = await bookingWorld(t, world);
      const a = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(0) })]));
      const b = await draft(fx, quoteBody(fx, [session(fx, { date: day(10) })]));
      const c = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(20) })]));
      const list = await t.http().get('/v1/bookings').set(fx.c.auth);
      expect(list.status).toBe(200);
      const parsed = BookingListResponseSchema.parse(list.body);
      expect(parsed.data.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
      expect(parsed.data[1]).toMatchObject({
        status: 'DRAFT',
        number: null,
        sessionCount: 1,
        customer: { id: fx.customer.id },
      });
      expect(parsed.data[2]?.grandTotal).toBe('100000.00');
      const ids = async (q: string) =>
        (await t.http().get(`/v1/bookings${q}`).set(fx.c.auth)).body.data.map(
          (x: { id: string }) => x.id,
        );
      expect(await ids('?status=TENTATIVE')).toEqual([c.id, a.id]);
      expect(await ids('?status=DRAFT')).toEqual([b.id]);
      expect(await ids(`?venueId=${fx.venue.id}`)).toHaveLength(3);
      expect(await ids(`?customerId=${fx.customer.id}`)).toHaveLength(3);
      expect(await ids('?customerId=nope')).toEqual([]);
      expect(await ids(`?from=${day(5)}&to=${day(15)}`)).toEqual([b.id]);
      expect(await ids(`?from=${day(20)}`)).toEqual([c.id]);
      expect(await ids(`?search=${encodeURIComponent(a.number)}`)).toEqual([a.id]);
      expect(await ids(`?search=${encodeURIComponent(fx.customer.name.slice(0, 8))}`)).toHaveLength(
        3,
      );
      expect(await ids('?search=%25')).toEqual([]);
      const page = await t.http().get('/v1/bookings?limit=2').set(fx.c.auth);
      expect(page.body.data).toHaveLength(2);
      const next = await t
        .http()
        .get(`/v1/bookings?limit=2&cursor=${page.body.nextCursor}`)
        .set(fx.c.auth);
      expect(next.body.data.map((x: { id: string }) => x.id)).toEqual([a.id]);
      expect((await t.http().get('/v1/bookings?cursor=garbage').set(fx.c.auth)).status).toBe(400);
      expect((await t.http().get('/v1/bookings?status=NOPE').set(fx.c.auth)).status).toBe(400);
      expect((await t.http().get('/v1/bookings').set(t.csrfHeaders)).status).toBe(401);
    });

    it('403 without booking.view; other workspaces and a foreign cursor are invisible', async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const theirs = await heldBooking(t, other);
      const nobody = await world.addMember(fx.c.tenant, { role: { permissions: ['venue.view'] } });
      expect(
        (
          await t
            .http()
            .get('/v1/bookings')
            .set(memberAuth(t, nobody, fx.c))
        ).status,
      ).toBe(403);
      expect((await t.http().get('/v1/bookings').set(fx.c.auth)).body.data).toEqual([]);
      const forged = Buffer.from(`b1:${theirs.id}`).toString('base64url');
      expect((await t.http().get(`/v1/bookings?cursor=${forged}`).set(fx.c.auth)).status).toBe(400);
    });
  });

  describe('prices are hidden from callers without booking.view_prices (Operations)', () => {
    it('totals, lines, sessions and summaries carry null; the quotation endpoints are 403', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(
        t,
        fx,
        quoteBody(fx, [
          session(fx, { packageId: fx.pkg.id, addOns: [{ addOnId: fx.addOns.fixed }] }),
        ]),
      );
      const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
      const auth = memberAuth(t, ops, fx.c);
      const res = await t.http().get(`/v1/bookings/${b.id}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        subtotal: null,
        discountTotal: null,
        taxTotal: null,
        grandTotal: null,
      });
      expect(res.body.grandTotal).toBeNull();
      expect(res.body.paidTotal).toBeNull();
      expect(res.body.lines.length).toBeGreaterThan(0);
      for (const line of res.body.lines) {
        expect(line).toMatchObject({
          unitPrice: null,
          amount: null,
          taxAmount: null,
          grossAmount: null,
        });
      }
      expect(res.body.sessions[0].subtotal).toBeNull();
      expect(res.body.quotations[0].grandTotal).toBeNull();
      expect(res.body.suggestedRefund).toBeNull();
      const text = JSON.stringify(res.body);
      for (const price of ['100000.00', '5000.00', '300000.00', '1500.00', '405000.00'])
        expect(text).not.toContain(price);
      const list = await t.http().get('/v1/bookings').set(auth);
      expect(list.body.data[0]).toMatchObject({ grandTotal: null, paidTotal: null });
      expect((await t.http().get(`/v1/quotations/${b.quotations[0].id}`).set(auth)).status).toBe(
        403,
      );
      expect((await t.http().get('/v1/quotations').set(auth)).status).toBe(403);
      // The cancellation answer hides the money too.
      const manager = await world.addMember(fx.c.tenant, {
        role: { permissions: ['venue.view', 'booking.view', 'booking.cancel'] },
      });
      const cancelled = await post(
        fx,
        `/v1/bookings/${b.id}/cancel`,
        { rev: b.rev, reason: 'No prices for me' },
        memberAuth(t, manager, fx.c),
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.refund).toMatchObject({ received: null, suggested: null });
    });
  });

  describe('venue scoping and other workspaces', () => {
    it('a caller limited to another venue sees nothing of this venue (404), and an empty list', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const second = await t.http().post('/v1/venues').set(fx.c.auth).send({ name: 'Other Hall' });
      const scoped = await world.addMember(fx.c.tenant, {
        role: 'branch_manager',
        venueIds: [second.body.id],
      });
      const auth = memberAuth(t, scoped, fx.c);
      expect((await t.http().get('/v1/bookings').set(auth)).body.data).toEqual([]);
      expect((await t.http().get(`/v1/bookings/${b.id}`).set(auth)).status).toBe(404);
      expect((await hold(fx, b, {}, auth)).status).toBe(404);
      expect(
        (await post(fx, `/v1/bookings/${b.id}/cancel`, { rev: b.rev, reason: 'Not mine' }, auth))
          .status,
      ).toBe(404);
      expect(
        (await t.http().get(`/v1/bookings?venueId=${fx.venue.id}`).set(auth)).body.data,
      ).toEqual([]);
      const mine = await world.addMember(fx.c.tenant, {
        role: 'branch_manager',
        venueIds: [fx.venue.id],
      });
      expect(
        (
          await t
            .http()
            .get(`/v1/bookings/${b.id}`)
            .set(memberAuth(t, mine, fx.c))
        ).status,
      ).toBe(200);
    });

    it("404 for another workspace's booking on every route (and nothing of it changes)", async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const theirs = await heldBooking(t, other);
      const sid = theirs.sessions[0].id;
      const attempts: [string, string, object | undefined][] = [
        ['get', `/v1/bookings/${theirs.id}`, undefined],
        ['patch', `/v1/bookings/${theirs.id}`, { rev: 1, notes: 'x' }],
        ['post', `/v1/bookings/${theirs.id}/hold`, { rev: 1 }],
        ['post', `/v1/bookings/${theirs.id}/extend-hold`, { rev: 1 }],
        ['post', `/v1/bookings/${theirs.id}/rehold`, { rev: 1 }],
        ['post', `/v1/bookings/${theirs.id}/confirm`, { rev: 1, override: true, reason: 'hijack' }],
        ['post', `/v1/bookings/${theirs.id}/cancel`, { rev: 1, reason: 'hijack' }],
        ['post', `/v1/bookings/${theirs.id}/restore`, { rev: 1 }],
        ['post', `/v1/bookings/${theirs.id}/sessions`, { rev: 1, session: session(fx) }],
        ['patch', `/v1/bookings/${theirs.id}/sessions/${sid}`, { rev: 1, guests: 5 }],
        ['post', `/v1/bookings/${theirs.id}/sessions/${sid}/cancel`, { rev: 1 }],
      ];
      for (const [method, path, body] of attempts) {
        const req = t.http()[method as 'get'](path).set(fx.c.auth);
        const res = body ? await req.send(body) : await req;
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
      }
      expect(await getBooking(t, other, theirs.id, other.c.auth)).toMatchObject({
        status: 'TENTATIVE',
        rev: theirs.rev,
      });
      // A session id of another booking of the SAME workspace is 404 too.
      const mine = await heldBooking(t, fx);
      expect(
        (await patch(fx, `/v1/bookings/${mine.id}/sessions/${sid}`, { rev: mine.rev, guests: 5 }))
          .status,
      ).toBe(404);
    });
  });

  describe('401 and 403 on every write', () => {
    it('anonymous callers get 401, a member without the permission 403', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const sid = b.sessions[0].id;
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' }); // booking.view only
      const routes: [string, string, object][] = [
        ['patch', `/v1/bookings/${b.id}`, { rev: b.rev, notes: 'x' }],
        ['post', `/v1/bookings/${b.id}/hold`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/extend-hold`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/rehold`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/confirm`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/cancel`, { rev: b.rev, reason: 'whatever' }],
        ['post', `/v1/bookings/${b.id}/restore`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/sessions`, { rev: b.rev, session: session(fx) }],
        ['patch', `/v1/bookings/${b.id}/sessions/${sid}`, { rev: b.rev, guests: 5 }],
        ['post', `/v1/bookings/${b.id}/sessions/${sid}/cancel`, { rev: b.rev }],
      ];
      for (const [method, path, body] of routes) {
        const anon = await t.http()[method as 'post'](path).set(t.csrfHeaders).send(body);
        expect(anon.status, `anon ${method} ${path}`).toBe(401);
        const call = t.http()[method as 'post'](path);
        const denied = await call.set(memberAuth(t, accountant, fx.c)).send(body);
        expect(denied.status, `accountant ${method} ${path}`).toBe(403);
      }
      expect((await t.http().get(`/v1/bookings/${b.id}`).set(t.csrfHeaders)).status).toBe(401);
    });

    it('400 for malformed ids and bodies', async () => {
      const fx = await bookingWorld(t, world);
      const b = await heldBooking(t, fx);
      const sid = b.sessions[0].id;
      for (const [method, path, body] of [
        ['post', `/v1/bookings/${b.id}/confirm`, { rev: 0 }],
        ['post', `/v1/bookings/${b.id}/cancel`, { rev: b.rev }],
        ['post', `/v1/bookings/${b.id}/sessions`, { rev: b.rev }],
        [
          'post',
          `/v1/bookings/${b.id}/sessions`,
          { rev: b.rev, session: { ...session(fx), guests: -1 } },
        ],
        ['patch', `/v1/bookings/${b.id}/sessions/${sid}`, { rev: b.rev }],
        [
          'patch',
          `/v1/bookings/${b.id}`,
          { rev: b.rev, discount: { type: 'PERCENT', value: 'ten' } },
        ],
      ] as const) {
        const res = await t.http()[method](path).set(fx.c.auth).send(body);
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
    });
  });
});
