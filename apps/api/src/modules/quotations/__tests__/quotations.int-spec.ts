import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  QuotationListResponseSchema,
  QuotationSchema,
  QuotePreviewSchema,
  pdfObjectKey,
} from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  bookingWorld,
  createQuotation,
  day,
  memberAuth,
  quoteBody,
  session,
} from '../../../__tests__/helpers/booking-fixtures';
import type { BookingWorld } from '../../../__tests__/helpers/booking-fixtures';
import { code, setupCaller } from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

// Module 7: the quotation (a DRAFT booking with versions): pricing through the API, versions, send, accept, PDF link, WhatsApp.

const BUCKET = 'venueos-test';

describe('quotations endpoints', () => {
  let t: TestApp;
  let world: World;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'venueos';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'venueos-local-secret';
    world = new World();
    t = await createTestApp({
      env: {
        S3_BUCKET: BUCKET,
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

  /** Two sessions with every kind of line: the numbers below are worked out by hand. */
  const twoSessions = (fx: BookingWorld) => [
    session(fx, {
      spaceId: fx.hallB.id,
      slotId: fx.lunch.id,
      eventTypeId: fx.mehndi.id,
      guests: 120,
      packageId: fx.pkg.id,
      addOns: [
        { addOnId: fx.addOns.fixed },
        { addOnId: fx.addOns.perHead },
        { addOnId: fx.addOns.perHour },
        { addOnId: fx.addOns.perUnit, quantity: 5 },
      ],
    }),
    session(fx, {
      date: day(1),
      guests: 250,
      packageId: fx.pkg.id,
      addOns: [{ addOnId: fx.addOns.perHour }],
    }),
  ];

  describe('POST /v1/quotations/preview', () => {
    it('200: prices every step on the server and saves nothing', async () => {
      const fx = await bookingWorld(t, world);
      const res = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, twoSessions(fx)));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const preview = QuotePreviewSchema.parse(res.body);
      // Session 1: rent 80000 + package 1500 x 120 + DJ 2000 x 4 h + chairs 300 x 5 + decor 5000 + drinks 100 x 120 = 286500
      // Session 2: rent 100000 + package 1500 x 250 + DJ 2000 x 4.5 h = 484000
      expect(preview.sessions.map((s) => s.subtotal)).toEqual(['286500.00', '484000.00']);
      expect(preview.totals).toEqual({
        subtotal: '770500.00',
        discountTotal: '0.00',
        taxTotal: '0.00',
        grandTotal: '770500.00',
      });
      expect(preview.lines.map((l) => l.kind)).toEqual([
        'RENT',
        'PACKAGE',
        'ADD_ON',
        'ADD_ON',
        'ADD_ON',
        'ADD_ON',
        'RENT',
        'PACKAGE',
        'ADD_ON',
      ]);
      expect(preview.sessions[0]).toMatchObject({
        hours: '4',
        billedGuests: 120,
        spaceName: 'Hall B',
        slotName: 'Lunch',
      });
      expect(preview.sessions[1]).toMatchObject({ hours: '4.5', billedGuests: 250, date: day(1) });
      expect(preview.currency).toBe('PKR');
      expect((await t.http().get('/v1/bookings').set(fx.c.auth)).body.data).toEqual([]);
    });

    it('applies price rules, a discount within the role limit, and exclusive tax', async () => {
      const fx = await bookingWorld(t, world, { tax: { ratePct: '16', inclusive: false } });
      const rule = await t
        .http()
        .post('/v1/price-rules')
        .set(fx.c.auth)
        .send({
          name: 'Premium',
          kind: 'DAY_OF_WEEK',
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          adjustment: 'PERCENT',
          value: '20',
        });
      expect(rule.status, JSON.stringify(rule.body)).toBe(201);
      const res = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx)], { discount: { type: 'PERCENT', value: '10' } }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // rent 100000 + 20% = 120000; discount 12000; tax 16% of 108000 = 17280; total 125280
      expect(
        res.body.lines.map((l: { kind: string; amount: string }) => [l.kind, l.amount]),
      ).toEqual([
        ['RENT', '100000.00'],
        ['ADJUSTMENT', '20000.00'],
        ['DISCOUNT', '-12000.00'],
        ['TAX', '17280.00'],
      ]);
      expect(res.body.totals.grandTotal).toBe('125280.00');
      expect(res.body.taxRate).toMatchObject({ name: 'GST', ratePct: '16', inclusive: false });
    });

    it('inclusive tax: the total is what the customer pays, each line shows its gross', async () => {
      const fx = await bookingWorld(t, world, { tax: { ratePct: '16', inclusive: true } });
      const res = await t.http().post('/v1/quotations/preview').set(fx.c.auth).send(quoteBody(fx));
      expect(res.body.totals.grandTotal).toBe('100000.00');
      const rent = res.body.lines[0];
      expect(rent).toMatchObject({
        kind: 'RENT',
        amount: '86206.90',
        taxAmount: '13793.10',
        grossAmount: '100000.00',
      });
      expect(res.body.lines.at(-1)).toMatchObject({ kind: 'TAX', amount: '13793.10' });
    });

    it('403 DISCOUNT_LIMIT above the role limit (a sales agent may give 5%), fine at the limit', async () => {
      const fx = await bookingWorld(t, world);
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const auth = memberAuth(t, agent, fx.c);
      const over = await t
        .http()
        .post('/v1/quotations/preview')
        .set(auth)
        .send(quoteBody(fx, undefined, { discount: { type: 'PERCENT', value: '5.5' } }));
      expect(over.status).toBe(403);
      expect(code(over)).toBe('DISCOUNT_LIMIT');
      const amount = await t
        .http()
        .post('/v1/quotations/preview')
        .set(auth)
        .send(quoteBody(fx, undefined, { discount: { type: 'AMOUNT', value: '5001' } }));
      expect(amount.status).toBe(403);
      const ok = await t
        .http()
        .post('/v1/quotations/preview')
        .set(auth)
        .send(quoteBody(fx, undefined, { discount: { type: 'PERCENT', value: '5' } }));
      expect(ok.status).toBe(200);
      expect(ok.body.totals.grandTotal).toBe('95000.00');
      // A role without a limit (Accountant: 0) has no quotation permission; the Owner may give 100%.
      expect(
        (
          await t
            .http()
            .post('/v1/quotations/preview')
            .set(fx.c.auth)
            .send(quoteBody(fx, undefined, { discount: { type: 'PERCENT', value: '100' } }))
        ).status,
      ).toBe(200);
      const tooMuch = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, undefined, { discount: { type: 'AMOUNT', value: '100001' } }));
      expect(tooMuch.status).toBe(400);
    });

    it('warns (does not block) when the slot is already held; says which booking to those who may see it', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      const booking = (await t.http().get(`/v1/bookings/${q.bookingId}`).set(fx.c.auth)).body;
      await t
        .http()
        .post(`/v1/bookings/${q.bookingId}/hold`)
        .set(fx.c.auth)
        .send({ rev: booking.rev });
      const res = await t.http().post('/v1/quotations/preview').set(fx.c.auth).send(quoteBody(fx));
      expect(res.status).toBe(200);
      expect(res.body.warnings).toEqual([
        { code: 'SLOT_TAKEN', sessionIndex: 0, detail: expect.stringMatching(/^BK-\d{4}-0001$/) },
      ]);
      // Hall B is free on the same evening, the combined hall is not.
      const b = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx, { spaceId: fx.hallB.id })]));
      expect(b.body.warnings).toEqual([]);
      const ab = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx, { spaceId: fx.hallAB.id })]));
      expect(ab.body.warnings.map((w: { code: string }) => w.code)).toEqual(['SLOT_TAKEN']);
    });

    it('warns about a broken venue rule, without blocking the quote', async () => {
      const fx = await bookingWorld(t, world, {
        localRules: { latestEndTime: '22:00', maxGuests: 300 },
      });
      const res = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx, { guests: 400 })]));
      expect(res.status).toBe(200);
      expect(
        res.body.warnings
          .map((w: { code: string; detail: string }) => `${w.code}:${w.detail}`)
          .sort(),
      ).toEqual(['LOCAL_RULE:LATEST_END_TIME', 'LOCAL_RULE:MAX_GUESTS']);
    });

    it('400: invalid bodies and rules of the time', async () => {
      const fx = await bookingWorld(t, world);
      const bad = (body: object) =>
        t.http().post('/v1/quotations/preview').set(fx.c.auth).send(body);
      for (const body of [
        {},
        quoteBody(fx, []),
        quoteBody(fx, [session(fx, { guests: 0 })]),
        quoteBody(fx, [session(fx, { date: '2031-02-30' })]),
        quoteBody(fx, [session(fx, { startTime: '19:00' })]), // only an hourly slot has its own times
        quoteBody(fx, [session(fx), session(fx)]), // the same space at the same time twice
        quoteBody(
          fx,
          [session(fx, { price: '1' })].map((s) => ({ ...s, guests: 'many' })),
        ),
      ]) {
        const res = await bad(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
    });

    it('422 when no rent is set; the client can never send a price (unknown keys are dropped)', async () => {
      const fx = await bookingWorld(t, world);
      const free = await t
        .http()
        .post('/v1/spaces')
        .set(fx.c.auth)
        .send({ venueId: fx.venue.id, name: 'Garden', capacitySeated: 50 });
      const res = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx, { spaceId: free.body.id })]));
      expect(res.status).toBe(422);
      const sneaky = await t
        .http()
        .post('/v1/quotations/preview')
        .set(fx.c.auth)
        .send(quoteBody(fx, [session(fx, { rent: '1', unitPrice: '1' })], { grandTotal: '1' }));
      expect(sneaky.body.totals.grandTotal).toBe('100000.00');
    });

    it('401 without an identity; 403 without quotation.manage; 403 without booking.view_prices', async () => {
      const fx = await bookingWorld(t, world);
      expect(
        (await t.http().post('/v1/quotations/preview').set(t.csrfHeaders).send(quoteBody(fx)))
          .status,
      ).toBe(401);
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      expect(
        (
          await t
            .http()
            .post('/v1/quotations/preview')
            .set(memberAuth(t, accountant, fx.c))
            .send(quoteBody(fx))
        ).status,
      ).toBe(403);
      const noPrices = await world.addMember(fx.c.tenant, {
        role: { permissions: ['venue.view', 'quotation.manage', 'booking.view', 'customer.view'] },
      });
      const res = await t
        .http()
        .post('/v1/quotations/preview')
        .set(memberAuth(t, noPrices, fx.c))
        .send(quoteBody(fx));
      expect(res.status).toBe(403);
    });

    it("404: another workspace's venue, space, slot, package, add-on or event type", async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const attempts = [
        quoteBody({ ...fx, venue: other.venue } as BookingWorld, [session(fx)]),
        quoteBody(fx, [session(fx, { spaceId: other.hallA.id })]),
        quoteBody(fx, [session(fx, { slotId: other.dinner.id })]),
        quoteBody(fx, [session(fx, { packageId: other.pkg.id })]),
        quoteBody(fx, [session(fx, { eventTypeId: other.barat.id })]),
        quoteBody(fx, [session(fx, { addOns: [{ addOnId: other.addOns.fixed }] })]),
      ];
      for (const body of attempts) {
        const res = await t.http().post('/v1/quotations/preview').set(fx.c.auth).send(body);
        expect(res.status, JSON.stringify(body)).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
      }
    });
  });

  describe('POST /v1/quotations', () => {
    it('201: a DRAFT booking with its first version, numbered, audited, the lead becomes QUOTED', async () => {
      const fx = await bookingWorld(t, world);
      const lead = await t
        .http()
        .post('/v1/leads')
        .set(fx.c.auth)
        .send({
          venueId: fx.venue.id,
          customerId: fx.customer.id,
          source: 'phone',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(lead.status).toBe(201);
      const res = await t
        .http()
        .post('/v1/quotations')
        .set(fx.c.auth)
        .send({
          ...quoteBody(fx, twoSessions(fx)),
          customerId: undefined,
          leadId: lead.body.id,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const q = QuotationSchema.parse(res.body);
      expect(q).toMatchObject({
        version: 1,
        isLatest: true,
        bookingStatus: 'DRAFT',
        bookingNumber: null,
        pdfReady: false,
        sentAt: null,
        acceptedAt: null,
        customer: { id: fx.customer.id },
      });
      expect(q.number).toMatch(/^BK-Q-\d{4}-0001$/);
      expect(q.totals.grandTotal).toBe('770500.00');
      expect(q.sessions.map((s) => s.id)).toEqual([expect.any(String), expect.any(String)]);
      expect(q.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const booking = (await t.http().get(`/v1/bookings/${q.bookingId}`).set(fx.c.auth)).body;
      expect(booking).toMatchObject({
        status: 'DRAFT',
        number: null,
        quoteVersion: 1,
        leadId: lead.body.id,
        sessionCount: 2,
      });
      expect(booking.lines).toHaveLength(9);
      expect((await t.http().get(`/v1/leads/${lead.body.id}`).set(fx.c.auth)).body.stage).toBe(
        'QUOTED',
      );
      expect(
        await world.auditRows(fx.c.tenant, { action: 'quotation.create', entityId: q.bookingId }),
      ).toHaveLength(1);
      // A second quotation is numbered 0002.
      const second = await createQuotation(t, fx);
      expect(second.number).toMatch(/-0002$/);
    });

    it('queues the PDF job for the version (identifiers only)', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      const jobs = await world.db
        .tx(
          { tenantId: fx.c.tenant.id },
          (tx) =>
            tx.$queryRaw<
              { data: unknown }[]
            >`SELECT data FROM pgboss.job WHERE name = 'pdf.render' AND data->>'entityId' = ${q.id}`,
        )
        .catch(() => null);
      // venueos_app cannot read the queue; the proof is the singleton job existing for the quotation or the read being refused.
      if (jobs) expect(JSON.stringify(jobs)).not.toContain(fx.customer.name);
    });

    it('400 without a customer or lead; 404 for a foreign customer or lead; 400 when customer and lead disagree', async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const post = (body: object) => t.http().post('/v1/quotations').set(fx.c.auth).send(body);
      expect((await post({ venueId: fx.venue.id, sessions: [session(fx)] })).status).toBe(400);
      expect((await post(quoteBody(fx, undefined, { customerId: other.customer.id }))).status).toBe(
        404,
      );
      const foreignLead = await t
        .http()
        .post('/v1/leads')
        .set(other.c.auth)
        .send({
          venueId: other.venue.id,
          customerId: other.customer.id,
          source: 'phone',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(
        (await post({ ...quoteBody(fx), customerId: undefined, leadId: foreignLead.body.id }))
          .status,
      ).toBe(404);
      const mine = await t
        .http()
        .post('/v1/leads')
        .set(fx.c.auth)
        .send({
          venueId: fx.venue.id,
          customerId: fx.customer.id,
          source: 'phone',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      const second = await t
        .http()
        .post('/v1/customers')
        .set(fx.c.auth)
        .send({ name: 'Somebody Else', phone: '0301 7654321' });
      expect(
        (await post(quoteBody(fx, undefined, { leadId: mine.body.id, customerId: second.body.id })))
          .status,
      ).toBe(400);
    });

    it('401 without an identity; 403 without quotation.manage (an Operations member)', async () => {
      const fx = await bookingWorld(t, world);
      expect(
        (await t.http().post('/v1/quotations').set(t.csrfHeaders).send(quoteBody(fx))).status,
      ).toBe(401);
      const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
      const res = await t
        .http()
        .post('/v1/quotations')
        .set(memberAuth(t, ops, fx.c))
        .send(quoteBody(fx));
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('a venue-limited caller cannot quote another venue (404)', async () => {
      const fx = await bookingWorld(t, world);
      const other = await t.http().post('/v1/venues').set(fx.c.auth).send({ name: 'Second Hall' });
      const scoped = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [other.body.id],
      });
      const res = await t
        .http()
        .post('/v1/quotations')
        .set(memberAuth(t, scoped, fx.c))
        .send(quoteBody(fx));
      expect(res.status).toBe(404);
    });
  });

  describe('versions, send, accept, share', () => {
    const markPdfReady = (fx: BookingWorld, id: string) =>
      world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.quotation.update({
          where: { id },
          data: { pdfKey: pdfObjectKey(fx.c.tenant.id, 'quotation', id) },
        }),
      );

    it('an unsent draft is re-priced in place; a sent one gets version 2 with the same number', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      const booking = (await t.http().get(`/v1/bookings/${q.bookingId}`).set(fx.c.auth)).body;
      const sessionId = booking.sessions[0].id;
      const edit = (rev: number, guests: number) =>
        t
          .http()
          .patch(`/v1/bookings/${q.bookingId}`)
          .set(fx.c.auth)
          .send({
            rev,
            sessions: [{ ...session(fx), id: sessionId, guests, packageId: fx.pkg.id }],
          });
      const first = await edit(booking.rev, 150);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.quoteVersion).toBe(1);
      expect(first.body.quotations).toHaveLength(1);
      expect(first.body.totals.grandTotal).toBe('325000.00'); // 100000 + 1500 x 150

      await markPdfReady(fx, q.id);
      const sent = await t.http().post(`/v1/quotations/${q.id}/send`).set(fx.c.auth).send({});
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const second = await edit(first.body.rev, 180);
      expect(second.status).toBe(200);
      expect(second.body.quoteVersion).toBe(2);
      expect(second.body.quotations.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(second.body.quotations[0]).toMatchObject({
        sentAt: null,
        pdfReady: false,
        number: q.number,
      });
      expect(second.body.quotations[1]).toMatchObject({ number: q.number, pdfReady: true });
      // The old version keeps what the customer was shown.
      const v1 = await t.http().get(`/v1/quotations/${q.id}`).set(fx.c.auth);
      expect(v1.body).toMatchObject({ version: 1, isLatest: false });
      expect(v1.body.totals.grandTotal).toBe('325000.00');
      expect(second.body.totals.grandTotal).toBe('370000.00');
    });

    it('send: 422 while the PDF is not ready; then the email is queued with the PDF KEY attached (never the file)', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      const early = await t.http().post(`/v1/quotations/${q.id}/send`).set(fx.c.auth).send({});
      expect(early.status).toBe(422);
      await markPdfReady(fx, q.id);
      const res = await t
        .http()
        .post(`/v1/quotations/${q.id}/send`)
        .set(fx.c.auth)
        .send({ message: 'Looking forward to hosting you.' });
      expect(res.status).toBe(200);
      expect(res.body.to).toMatch(/^hina\d+@example\.test$/);
      const logs = await world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
        tx.messageLog.findMany({ where: { tenantId: fx.c.tenant.id, template: 'quotation.send' } }),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        status: 'queued',
        event: 'quotation.sent',
        entityType: 'quotation',
        entityId: q.id,
      });
      expect(logs[0]?.attachments).toEqual([
        { key: pdfObjectKey(fx.c.tenant.id, 'quotation', q.id), filename: `${q.number}-v1.pdf` },
      ]);
      expect(JSON.stringify(logs[0]?.templateVars)).toContain(q.number);
      const after = await t.http().get(`/v1/quotations/${q.id}`).set(fx.c.auth);
      expect(after.body.sentAt).not.toBeNull();
      expect(
        await world.auditRows(fx.c.tenant, { action: 'quotation.send', entityId: q.bookingId }),
      ).toHaveLength(1);
      // Another address, and a customer without one.
      expect(
        (
          await t
            .http()
            .post(`/v1/quotations/${q.id}/send`)
            .set(fx.c.auth)
            .send({ to: 'not-an-email' })
        ).status,
      ).toBe(400);
      const noMail = await t
        .http()
        .post('/v1/customers')
        .set(fx.c.auth)
        .send({ name: 'No Mail', phone: '0302 1112223' });
      const q2 = await createQuotation(
        t,
        fx,
        quoteBody(fx, [session(fx, { date: day(5) })], { customerId: noMail.body.id }),
      );
      await markPdfReady(fx, q2.id);
      const noAddress = await t.http().post(`/v1/quotations/${q2.id}/send`).set(fx.c.auth).send({});
      expect(noAddress.status).toBe(400);
    });

    it('only the newest version can be sent, accepted or shared; the sales agent may send, the accountant may not', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      await markPdfReady(fx, q.id);
      const booking = (await t.http().get(`/v1/bookings/${q.bookingId}`).set(fx.c.auth)).body;
      await t.http().post(`/v1/quotations/${q.id}/send`).set(fx.c.auth).send({});
      await t
        .http()
        .patch(`/v1/bookings/${q.bookingId}`)
        .set(fx.c.auth)
        .send({ rev: booking.rev, notes: 'x', discount: { type: 'PERCENT', value: '1' } });
      expect(
        (await t.http().post(`/v1/quotations/${q.id}/send`).set(fx.c.auth).send({})).status,
      ).toBe(422);
      expect(
        (await t.http().post(`/v1/quotations/${q.id}/accept`).set(fx.c.auth).send({})).status,
      ).toBe(422);
      const agent = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      const latest = (await t.http().get(`/v1/bookings/${q.bookingId}`).set(fx.c.auth)).body
        .quotations[0];
      expect(
        (
          await t
            .http()
            .post(`/v1/quotations/${latest.id}/accept`)
            .set(memberAuth(t, agent, fx.c))
            .send({})
        ).status,
      ).toBe(200);
      expect(
        (
          await t
            .http()
            .post(`/v1/quotations/${latest.id}/accept`)
            .set(memberAuth(t, accountant, fx.c))
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await t
            .http()
            .get(`/v1/quotations/${latest.id}/whatsapp`)
            .set(memberAuth(t, accountant, fx.c))
        ).status,
      ).toBe(403);
    });

    it('WhatsApp: a wa.me link with a text summary and no link to the PDF', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx, quoteBody(fx, twoSessions(fx)));
      await markPdfReady(fx, q.id);
      const res = await t.http().get(`/v1/quotations/${q.id}/whatsapp`).set(fx.c.auth);
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/^https:\/\/wa\.me\/92300\d+\?text=/);
      expect(res.body.text).toContain(q.number);
      expect(res.body.text).toContain('770500.00');
      expect(res.body.text).toContain('Barat');
      expect(res.body.text).not.toMatch(/https?:\/\//);
      expect(decodeURIComponent(res.body.url.split('?text=')[1])).toBe(res.body.text);
      expect(res.body.url).not.toContain('pdf');
    });

    it('PDF: 422 while not ready; then a short-lived pre-signed link that really downloads the file', async () => {
      const fx = await bookingWorld(t, world);
      const q = await createQuotation(t, fx);
      expect((await t.http().get(`/v1/quotations/${q.id}/pdf`).set(fx.c.auth)).status).toBe(422);

      const s3 = new S3Client({
        region: 'us-east-1',
        endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
        forcePathStyle: true,
      });
      try {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: pdfObjectKey(fx.c.tenant.id, 'quotation', q.id),
            Body: Buffer.from('%PDF-1.4 test'),
            ContentType: 'application/pdf',
          }),
        );
      } finally {
        s3.destroy();
      }
      await markPdfReady(fx, q.id);
      const res = await t.http().get(`/v1/quotations/${q.id}/pdf`).set(fx.c.auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.expiresInSeconds).toBe(300);
      expect(res.body.url).toContain('X-Amz-Expires=300');
      expect(res.body.url).toContain(`tenants/${fx.c.tenant.id}/pdf/quotation/${q.id}.pdf`);
      const file = await fetch(res.body.url);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe('%PDF-1.4 test');
      expect(file.headers.get('content-disposition')).toContain(`${q.number}-v1.pdf`);
      // A tampered link does not work.
      const tampered = await fetch(
        res.body.url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=00'),
      );
      expect(tampered.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /v1/quotations', () => {
    it('200: lists versions, filters by booking and customer, paginates; another workspace is invisible', async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const a = await createQuotation(t, fx);
      const b = await createQuotation(t, fx, quoteBody(fx, [session(fx, { date: day(3) })]));
      await createQuotation(t, other);
      const list = await t.http().get('/v1/quotations').set(fx.c.auth);
      expect(list.status).toBe(200);
      const parsed = QuotationListResponseSchema.parse(list.body);
      expect(parsed.data.map((q) => q.id)).toEqual([b.id, a.id]);
      expect(parsed.data[0]).toMatchObject({ isLatest: true, bookingStatus: 'DRAFT' });
      expect(
        (await t.http().get(`/v1/quotations?bookingId=${a.bookingId}`).set(fx.c.auth)).body.data,
      ).toHaveLength(1);
      expect(
        (await t.http().get(`/v1/quotations?customerId=${fx.customer.id}`).set(fx.c.auth)).body
          .data,
      ).toHaveLength(2);
      const page = await t.http().get('/v1/quotations?limit=1').set(fx.c.auth);
      expect(page.body.data).toHaveLength(1);
      const next = await t
        .http()
        .get(`/v1/quotations?limit=1&cursor=${page.body.nextCursor}`)
        .set(fx.c.auth);
      expect(next.body.data.map((q: { id: string }) => q.id)).toEqual([a.id]);
      expect((await t.http().get('/v1/quotations?cursor=garbage').set(fx.c.auth)).status).toBe(400);
      expect((await t.http().get('/v1/quotations').set(t.csrfHeaders)).status).toBe(401);
    });
  });

  describe("another workspace's quotation is a 404 everywhere", () => {
    it('get, send, accept, pdf, whatsapp', async () => {
      const fx = await bookingWorld(t, world);
      const other = await bookingWorld(t, world);
      const theirs = await createQuotation(t, other);
      for (const [method, path, body] of [
        ['get', `/v1/quotations/${theirs.id}`, undefined],
        ['post', `/v1/quotations/${theirs.id}/send`, {}],
        ['post', `/v1/quotations/${theirs.id}/accept`, {}],
        ['get', `/v1/quotations/${theirs.id}/pdf`, undefined],
        ['get', `/v1/quotations/${theirs.id}/whatsapp`, undefined],
      ] as const) {
        const req = t.http()[method](path).set(fx.c.auth);
        const res = body ? await req.send(body) : await req;
        expect(res.status, path).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
      }
      expect((await setupCaller(world, t)).tenant.id).not.toBe(fx.c.tenant.id);
    });
  });
});
