import {
  CancellationPolicySchema,
  PriceRuleSchema,
  RentPreviewSchema,
  TaxRateSchema,
} from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { crudMatrix, nextN } from '../../../__tests__/helpers/crud-matrix';
import {
  NO_VENUE_ACCESS,
  code,
  makeSlot,
  makeSpace,
  makeVenue,
  scopedManagerAuth,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

// Module 3, pricing: price rules, rent preview, tax rates, cancellation policies. The shared access matrix covers
// 2xx / 400 / 401 / 403 / other-tenant 404 / rev / audit; the rest is specific rules.

const TIERS = [
  { minDaysBefore: 60, refundPct: 80 },
  { minDaysBefore: 30, refundPct: 50 },
  { minDaysBefore: 0, refundPct: 0 },
];

describe('pricing endpoints', () => {
  let t: TestApp;
  let world: World;
  const env = () => ({ t, world });

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  describe('tax rates', () => {
    crudMatrix(
      {
        path: '/v1/tax-rates',
        create: (n) => ({ name: `GST ${n}`, ratePct: '16', inclusive: false }),
        invalid: { name: 'Too much', ratePct: '101' },
        change: { ratePct: '17.5', inclusive: true },
        changed: { ratePct: '17.50', inclusive: true },
        audit: { create: 'tax_rate.create', update: 'tax_rate.update' },
        parse: (b) => TaxRateSchema.parse(b),
        uniqueName: 'name',
        softDelete: true,
      },
      env,
    );

    const post = (auth: Record<string, string>, body: Record<string, unknown>) =>
      t.http().post('/v1/tax-rates').set(auth).send(body);
    const defaults = async (auth: Record<string, string>) =>
      (await t.http().get('/v1/tax-rates?includeInactive=true').set(auth)).body.data.filter(
        (r: { isDefault: boolean }) => r.isDefault,
      ) as { id: string; name: string }[];

    it('one default: a new default takes the flag, and the old one is audited as changed', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const gst = (await post(auth, { name: 'GST', ratePct: '16', isDefault: true })).body;
      expect(gst.isDefault).toBe(true);
      const vat = (await post(auth, { name: 'VAT', ratePct: '5', isDefault: true })).body;
      expect(vat.isDefault).toBe(true);
      expect((await defaults(auth)).map((r) => r.name)).toEqual(['VAT']);
      const rows = await world.auditRows(tenant, { action: 'tax_rate.update', entityId: gst.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toMatchObject({ isDefault: true });
      expect(rows[0]?.after).toMatchObject({ isDefault: false });
      // Moving the flag with a PATCH works the same way.
      const back = await t
        .http()
        .patch(`/v1/tax-rates/${gst.id}`)
        .set(auth)
        .send({ rev: 2, isDefault: true });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect((await defaults(auth)).map((r) => r.name)).toEqual(['GST']);
    });

    it('deactivating the default clears the flag; an inactive rate cannot be made the default', async () => {
      const { auth } = await setupCaller(world, t);
      const gst = (await post(auth, { name: 'GST', ratePct: '16', isDefault: true })).body;
      const off = await t
        .http()
        .patch(`/v1/tax-rates/${gst.id}`)
        .set(auth)
        .send({ rev: gst.rev, active: false });
      expect(off.body).toMatchObject({ active: false, isDefault: false });
      expect(await defaults(auth)).toEqual([]);
      const bad = await t
        .http()
        .patch(`/v1/tax-rates/${gst.id}`)
        .set(auth)
        .send({ rev: off.body.rev, isDefault: true });
      expect(bad.status).toBe(400);
      expect(code(bad)).toBe('VALIDATION_ERROR');
    });

    it('a default can be unset, leaving the workspace with none; each tenant has its own', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const mine = (await post(a.auth, { name: 'GST', ratePct: '16', isDefault: true })).body;
      await post(b.auth, { name: 'GST', ratePct: '16', isDefault: true });
      const res = await t
        .http()
        .patch(`/v1/tax-rates/${mine.id}`)
        .set(a.auth)
        .send({ rev: mine.rev, isDefault: false });
      expect(res.body.isDefault).toBe(false);
      expect(await defaults(b.auth)).toHaveLength(1);
    });

    it('stores the rate with 2 decimals, inclusive or exclusive', async () => {
      const { auth } = await setupCaller(world, t);
      const res = await post(auth, { name: 'Incl', ratePct: '13', inclusive: true });
      expect(res.body).toMatchObject({ ratePct: '13.00', inclusive: true, isDefault: false });
      expect((await post(auth, { name: 'Bad', ratePct: '12.345' })).status).toBe(400);
    });
  });

  describe('cancellation policies', () => {
    crudMatrix(
      {
        path: '/v1/cancellation-policies',
        create: (n) => ({ name: `Standard ${n}`, tiers: TIERS }),
        invalid: { name: 'No zero tier', tiers: [{ minDaysBefore: 30, refundPct: 50 }] },
        change: {
          tiers: [
            { minDaysBefore: 14, refundPct: 100 },
            { minDaysBefore: 0, refundPct: 10 },
          ],
        },
        changed: {
          tiers: [
            { minDaysBefore: 14, refundPct: 100 },
            { minDaysBefore: 0, refundPct: 10 },
          ],
        },
        audit: { create: 'cancellation_policy.create', update: 'cancellation_policy.update' },
        parse: (b) => CancellationPolicySchema.parse(b),
        uniqueName: 'name',
        softDelete: true,
      },
      env,
    );

    const post = (auth: Record<string, string>, body: Record<string, unknown>) =>
      t.http().post('/v1/cancellation-policies').set(auth).send(body);

    it('400: tiers out of order, duplicated, missing the 0-day tier, or with a refund over 100', async () => {
      const { auth } = await setupCaller(world, t);
      const bad = async (tiers: unknown) => {
        const res = await post(auth, { name: `P ${nextN()}`, tiers });
        expect(res.status, JSON.stringify(tiers)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      };
      await bad([]);
      await bad([
        { minDaysBefore: 0, refundPct: 0 },
        { minDaysBefore: 30, refundPct: 50 },
      ]);
      await bad([
        { minDaysBefore: 30, refundPct: 50 },
        { minDaysBefore: 30, refundPct: 20 },
        { minDaysBefore: 0, refundPct: 0 },
      ]);
      await bad([{ minDaysBefore: 10, refundPct: 50 }]);
      await bad([{ minDaysBefore: 0, refundPct: 100.5 }]);
      await bad([{ minDaysBefore: 0, refundPct: -1 }]);
      // A patch is held to the same rules.
      const ok = (await post(auth, { name: 'Fine', tiers: TIERS })).body;
      const patch = await t
        .http()
        .patch(`/v1/cancellation-policies/${ok.id}`)
        .set(auth)
        .send({ rev: ok.rev, tiers: [{ minDaysBefore: 5, refundPct: 10 }] });
      expect(patch.status).toBe(400);
    });

    it('one default per workspace, moved by create and patch, cleared by deactivating', async () => {
      const { auth } = await setupCaller(world, t);
      const one = (await post(auth, { name: 'One', tiers: TIERS, isDefault: true })).body;
      const two = (await post(auth, { name: 'Two', tiers: TIERS, isDefault: true })).body;
      const list = await t.http().get('/v1/cancellation-policies').set(auth);
      expect(
        list.body.data
          .filter((p: { isDefault: boolean }) => p.isDefault)
          .map((p: { id: string }) => p.id),
      ).toEqual([two.id]);
      const off = await t
        .http()
        .patch(`/v1/cancellation-policies/${two.id}`)
        .set(auth)
        .send({ rev: two.rev, active: false });
      expect(off.body).toMatchObject({ active: false, isDefault: false });
      const inactiveDefault = await t
        .http()
        .patch(`/v1/cancellation-policies/${two.id}`)
        .set(auth)
        .send({ rev: off.body.rev, isDefault: true });
      expect(inactiveDefault.status).toBe(400);
      expect(one.isDefault).toBe(true);
    });

    it('keeps the tiers exactly as sent (order and decimals)', async () => {
      const { auth } = await setupCaller(world, t);
      const res = await post(auth, {
        name: 'Fine print',
        tiers: [
          { minDaysBefore: 90, refundPct: 87.5 },
          { minDaysBefore: 0, refundPct: 0 },
        ],
      });
      expect(res.body.tiers).toEqual([
        { minDaysBefore: 90, refundPct: 87.5 },
        { minDaysBefore: 0, refundPct: 0 },
      ]);
    });
  });

  describe('price rules', () => {
    crudMatrix(
      {
        path: '/v1/price-rules',
        create: (n) => ({
          name: `Weekend ${n}`,
          kind: 'DAY_OF_WEEK',
          daysOfWeek: [5, 6],
          adjustment: 'PERCENT',
          value: '20',
        }),
        invalid: { name: 'No days', kind: 'DAY_OF_WEEK', adjustment: 'PERCENT', value: '20' },
        change: { priority: 5, value: '25' },
        changed: { priority: 5, value: '25' },
        audit: { create: 'price_rule.create', update: 'price_rule.update' },
        parse: (b) => PriceRuleSchema.parse(b),
        softDelete: true,
      },
      env,
    );

    const post = (auth: Record<string, string>, body: Record<string, unknown>) =>
      t.http().post('/v1/price-rules').set(auth).send(body);
    const season = (extra: Record<string, unknown> = {}) => ({
      name: `Season ${nextN()}`,
      kind: 'DATE_RANGE',
      startDate: '2027-11-01',
      endDate: '2027-12-31',
      adjustment: 'PERCENT',
      value: '10',
      ...extra,
    });

    it('201: each kind with its own shape; money values use the currency decimals, a percentage is kept as written', async () => {
      const { auth } = await setupCaller(world, t);
      const range = await post(auth, season());
      expect(range.status, JSON.stringify(range.body)).toBe(201);
      expect(range.body).toMatchObject({
        kind: 'DATE_RANGE',
        startDate: '2027-11-01',
        endDate: '2027-12-31',
        daysOfWeek: [],
        value: '10',
        priority: 0,
        spaceId: null,
        venueId: null,
      });
      const day = await post(auth, {
        name: 'Eid',
        kind: 'SPECIFIC_DATE',
        startDate: '2027-03-10',
        adjustment: 'OVERRIDE',
        value: '250000',
        priority: 9,
      });
      expect(day.body).toMatchObject({ endDate: null, value: '250000.00', priority: 9 });
      const fixed = await post(auth, {
        name: 'Discount',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [1, 2],
        adjustment: 'FIXED_AMOUNT',
        value: '-5000.5',
      });
      expect(fixed.body.value).toBe('-5000.50');
      expect((await post(auth, { ...season(), value: '-7.5' })).body.value).toBe('-7.5');
    });

    it('400: a bad date range, a date that does not exist, a value outside its kind, extra fields for the kind', async () => {
      const { auth } = await setupCaller(world, t);
      const bad = async (body: Record<string, unknown>, why: string) => {
        const res = await post(auth, body);
        expect(res.status, why).toBe(400);
        expect(code(res), why).toBe('VALIDATION_ERROR');
      };
      await bad(season({ startDate: '2027-12-31', endDate: '2027-11-01' }), 'end before start');
      await bad(season({ endDate: undefined }), 'no end date');
      await bad(season({ startDate: '2027-02-30' }), 'impossible date');
      await bad(season({ daysOfWeek: [6] }), 'weekdays on a season');
      await bad(
        {
          name: 'x',
          kind: 'SPECIFIC_DATE',
          startDate: '2027-03-10',
          endDate: '2027-03-11',
          adjustment: 'PERCENT',
          value: '5',
        },
        'end on a single date',
      );
      await bad(season({ value: '-101' }), 'percent below -100');
      await bad(season({ value: '1001' }), 'percent above 1000');
      await bad(season({ value: '0' }), 'zero percent');
      await bad(season({ adjustment: 'OVERRIDE', value: '-5' }), 'negative override');
      await bad(
        season({ adjustment: 'FIXED_AMOUNT', value: '10.005' }),
        'too many decimals for PKR',
      );
      await bad(season({ adjustment: 'NOPE' }), 'unknown adjustment');
      await bad(season({ priority: 5000 }), 'priority range');
    });

    it('404: a space or slot of another tenant; 400: a space and slot of different venues', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venueB = await makeVenue(t, b.auth);
      const spaceB = await makeSpace(t, b.auth, venueB.id);
      const slotB = await makeSlot(t, b.auth, venueB.id);
      const withSpace = await post(a.auth, season({ spaceId: spaceB.id }));
      expect(withSpace.status).toBe(404);
      expect(JSON.stringify(withSpace.body)).not.toContain(spaceB.id);
      expect((await post(a.auth, season({ slotId: slotB.id }))).status).toBe(404);

      const v1 = await makeVenue(t, a.auth, { name: 'One' });
      const v2 = await makeVenue(t, a.auth, { name: 'Two' });
      const space1 = await makeSpace(t, a.auth, v1.id);
      const slot2 = await makeSlot(t, a.auth, v2.id);
      const mixed = await post(a.auth, season({ spaceId: space1.id, slotId: slot2.id }));
      expect(mixed.status).toBe(400);
    });

    it('a rule scoped to a space shows its venue; the audit row carries the venue', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const space = await makeSpace(t, auth, venue.id);
      const slot = await makeSlot(t, auth, venue.id);
      const res = await post(auth, season({ spaceId: space.id, slotId: slot.id }));
      expect(res.body).toMatchObject({ spaceId: space.id, slotId: slot.id, venueId: venue.id });
      const rows = await world.auditRows(tenant, {
        action: 'price_rule.create',
        entityId: res.body.id,
      });
      expect(rows[0]?.venueId).toBe(venue.id);
      const filtered = await t.http().get(`/v1/price-rules?spaceId=${space.id}`).set(auth);
      expect(filtered.body.data.map((r: { id: string }) => r.id)).toEqual([res.body.id]);
    });

    it('PATCH validates the merged rule: changing the kind needs its fields; clearing works', async () => {
      const { auth } = await setupCaller(world, t);
      const rule = (await post(auth, season())).body;
      const path = `/v1/price-rules/${rule.id}`;
      // A season turned into a weekday rule still has its dates -> 400, naming them.
      const half = await t
        .http()
        .patch(path)
        .set(auth)
        .send({ rev: rule.rev, kind: 'DAY_OF_WEEK', daysOfWeek: [6] });
      expect(half.status).toBe(400);
      expect(JSON.stringify(half.body)).toContain('startDate');
      const full = await t
        .http()
        .patch(path)
        .set(auth)
        .send({
          rev: rule.rev,
          kind: 'DAY_OF_WEEK',
          daysOfWeek: [6],
          startDate: null,
          endDate: null,
        });
      expect(full.status, JSON.stringify(full.body)).toBe(200);
      expect(full.body).toMatchObject({
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        startDate: null,
        endDate: null,
      });
      const bad = await t
        .http()
        .patch(path)
        .set(auth)
        .send({ rev: full.body.rev, adjustment: 'OVERRIDE', value: '-1' });
      expect(bad.status).toBe(400);
    });

    it('a venue-limited manager manages rules of their own venues only', async () => {
      const owner = await setupCaller(world, t);
      const mine = await makeVenue(t, owner.auth, { name: 'Mine' });
      const other = await makeVenue(t, owner.auth, { name: 'Other' });
      const mySpace = await makeSpace(t, owner.auth, mine.id);
      const otherSpace = await makeSpace(t, owner.auth, other.id);
      const scoped = await scopedManagerAuth(world, t, owner.tenant, [mine.id]);

      const ok = await post(scoped, season({ spaceId: mySpace.id }));
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect((await post(scoped, season({ spaceId: otherSpace.id }))).status).toBe(404);
      const everywhere = await post(scoped, season());
      expect(everywhere.status).toBe(403);
      expect(code(everywhere)).toBe('FORBIDDEN');

      // Edit their own, not the workspace-wide or another venue's.
      const wide = (await post(owner.auth, season())).body;
      const theirs = (await post(owner.auth, season({ spaceId: otherSpace.id }))).body;
      const edit = (id: string, rev: number) =>
        t.http().patch(`/v1/price-rules/${id}`).set(scoped).send({ rev, priority: 3 });
      expect((await edit(ok.body.id, ok.body.rev)).status).toBe(200);
      expect((await edit(wide.id, wide.rev)).status).toBe(403);
      expect((await edit(theirs.id, theirs.rev)).status).toBe(404);
      // They cannot widen their rule to everywhere, nor move it to another venue.
      const widen = await t
        .http()
        .patch(`/v1/price-rules/${ok.body.id}`)
        .set(scoped)
        .send({ rev: 2, spaceId: null });
      expect(widen.status).toBe(403);
      const move = await t
        .http()
        .patch(`/v1/price-rules/${ok.body.id}`)
        .set(scoped)
        .send({ rev: 2, spaceId: otherSpace.id });
      expect(move.status).toBe(404);
      // Reading is workspace-wide.
      expect(
        (await t.http().get('/v1/price-rules').set(scoped)).body.data.length,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe('GET /v1/pricing/rent-preview', () => {
    interface Setup {
      auth: Record<string, string>;
      ownerAuth: Record<string, string>;
      venueId: string;
      spaceId: string;
      dinnerId: string;
      lunchId: string;
    }

    async function setup(): Promise<
      Setup & { tenant: Awaited<ReturnType<typeof setupCaller>>['tenant'] }
    > {
      const caller = await setupCaller(world, t);
      const venue = await makeVenue(t, caller.auth);
      const space = await makeSpace(t, caller.auth, venue.id);
      const dinner = await makeSlot(t, caller.auth, venue.id, {
        name: 'Dinner',
        startTime: '19:00',
        endTime: '23:30',
      });
      const lunch = await makeSlot(t, caller.auth, venue.id, { name: 'Lunch' });
      const prices = await t
        .http()
        .put(`/v1/spaces/${space.id}/slot-prices`)
        .set(caller.auth)
        .send({ prices: [{ slotId: dinner.id, rent: '100000' }] });
      expect(prices.status).toBe(200);
      return {
        tenant: caller.tenant,
        auth: caller.auth,
        ownerAuth: caller.ownerAuth,
        venueId: venue.id,
        spaceId: space.id,
        dinnerId: dinner.id,
        lunchId: lunch.id,
      };
    }

    const preview = (s: Setup, query: Record<string, string>, auth = s.auth) => {
      const params = new URLSearchParams({
        venueId: s.venueId,
        spaceId: s.spaceId,
        slotId: s.dinnerId,
        ...query,
      });
      return t.http().get(`/v1/pricing/rent-preview?${params.toString()}`).set(auth);
    };
    const rule = (auth: Record<string, string>, body: Record<string, unknown>) =>
      t
        .http()
        .post('/v1/price-rules')
        .set(auth)
        .send(body)
        .then((r) => {
          expect(r.status, JSON.stringify(r.body)).toBe(201);
          return r.body as { id: string };
        });

    it('200: the base rent alone when no rule applies', async () => {
      const s = await setup();
      const res = await preview(s, { date: '2027-01-04' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(RentPreviewSchema.parse(res.body)).toMatchObject({
        currency: 'PKR',
        weekday: 1,
        slotMode: 'FIXED',
        hours: null,
        unitRent: '100000.00',
        baseSource: 'SLOT_PRICE',
        baseRent: '100000.00',
        adjustments: [],
        notApplied: [],
        finalRent: '100000.00',
      });
    });

    it('a weekend +20% and a season override, each rule in the order applied', async () => {
      const s = await setup();
      const weekend = await rule(s.auth, {
        name: 'Weekend',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [5, 6],
        adjustment: 'PERCENT',
        value: '20',
        priority: 1,
      });
      const january = await rule(s.auth, {
        name: 'January season',
        kind: 'DATE_RANGE',
        startDate: '2027-01-01',
        endDate: '2027-01-31',
        adjustment: 'OVERRIDE',
        value: '150000',
        priority: 5,
      });

      // Saturday 2 Jan: override 150000, then +20% = 180000.
      const sat = await preview(s, { date: '2027-01-02' });
      expect(sat.body.adjustments).toEqual([
        {
          ruleId: january.id,
          name: 'January season',
          kind: 'DATE_RANGE',
          adjustment: 'OVERRIDE',
          value: '150000.00',
          amount: '50000.00',
          rentAfter: '150000.00',
        },
        {
          ruleId: weekend.id,
          name: 'Weekend',
          kind: 'DAY_OF_WEEK',
          adjustment: 'PERCENT',
          value: '20',
          amount: '30000.00',
          rentAfter: '180000.00',
        },
      ]);
      expect(sat.body.finalRent).toBe('180000.00');
      // Monday 4 Jan: the season only. Saturday 6 Feb: the weekend only. Monday 1 Feb: nothing.
      expect((await preview(s, { date: '2027-01-04' })).body.finalRent).toBe('150000.00');
      expect((await preview(s, { date: '2027-02-06' })).body.finalRent).toBe('120000.00');
      expect((await preview(s, { date: '2027-02-01' })).body.finalRent).toBe('100000.00');
    });

    it('scope: a rule for another space or slot does not apply; the loser of two overrides is listed', async () => {
      const s = await setup();
      const otherSpace = await makeSpace(t, s.auth, s.venueId, { name: 'Hall B' });
      await rule(s.auth, {
        name: 'Hall B only',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        spaceId: otherSpace.id,
        adjustment: 'PERCENT',
        value: '50',
      });
      await rule(s.auth, {
        name: 'Lunch only',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        slotId: s.lunchId,
        adjustment: 'PERCENT',
        value: '50',
      });
      const low = await rule(s.auth, {
        name: 'Low override',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        adjustment: 'OVERRIDE',
        value: '90000',
        priority: 1,
      });
      await rule(s.auth, {
        name: 'High override',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        adjustment: 'OVERRIDE',
        value: '95000',
        priority: 2,
      });
      const res = await preview(s, { date: '2027-01-02' });
      expect(res.body.finalRent).toBe('95000.00');
      expect(res.body.adjustments).toHaveLength(1);
      expect(res.body.notApplied).toEqual([{ ruleId: low.id, name: 'Low override' }]);
    });

    it('an inactive rule is ignored', async () => {
      const s = await setup();
      const r = await rule(s.auth, {
        name: 'Off',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        adjustment: 'PERCENT',
        value: '20',
      });
      await t.http().patch(`/v1/price-rules/${r.id}`).set(s.auth).send({ rev: 1, active: false });
      expect((await preview(s, { date: '2027-01-02' })).body.finalRent).toBe('100000.00');
    });

    it("falls back to the space's base rent when the slot has no price of its own", async () => {
      const s = await setup();
      await t
        .http()
        .patch(`/v1/spaces/${s.spaceId}`)
        .set(s.auth)
        .send({ rev: 1, baseRent: '80000' });
      const res = await preview(s, { date: '2027-01-04', slotId: s.lunchId });
      expect(res.body).toMatchObject({ baseSource: 'SPACE_BASE_RENT', finalRent: '80000.00' });
    });

    it('422: no rent at all for that space and slot', async () => {
      const s = await setup();
      const res = await preview(s, { date: '2027-01-04', slotId: s.lunchId });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('INVALID_STATE_TRANSITION');
    });

    it('an HOURLY slot: rent per hour x hours, rules on the total, minimum hours enforced', async () => {
      const caller = await setupCaller(world, t);
      const venue = await makeVenue(t, caller.auth, { opensAt: '10:00', closesAt: '23:00' });
      const space = await makeSpace(t, caller.auth, venue.id);
      const hourly = await makeSlot(t, caller.auth, venue.id, {
        name: 'By the hour',
        mode: 'HOURLY',
        startTime: undefined,
        endTime: undefined,
        minHours: 2,
      });
      await t
        .http()
        .put(`/v1/spaces/${space.id}/slot-prices`)
        .set(caller.auth)
        .send({ prices: [{ slotId: hourly.id, rent: '5000' }] });
      await t
        .http()
        .post('/v1/price-rules')
        .set(caller.auth)
        .send({
          name: 'Plus 10',
          kind: 'DAY_OF_WEEK',
          daysOfWeek: [6],
          adjustment: 'PERCENT',
          value: '10',
        });
      const q = (extra: Record<string, string>) =>
        t
          .http()
          .get(
            `/v1/pricing/rent-preview?${new URLSearchParams({ venueId: venue.id, spaceId: space.id, slotId: hourly.id, date: '2027-01-02', ...extra }).toString()}`,
          )
          .set(caller.auth);
      const ok = await q({ hours: '3.5' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({
        slotMode: 'HOURLY',
        hours: '3.5',
        unitRent: '5000.00',
        baseRent: '17500.00',
        finalRent: '19250.00',
      });
      expect((await q({})).status).toBe(400);
      expect((await q({ hours: '1' })).status).toBe(400);
      expect((await q({ hours: '25' })).status).toBe(400);
    });

    it('400: hours for a fixed slot, a day the slot is not offered, a malformed query', async () => {
      const s = await setup();
      expect((await preview(s, { date: '2027-01-04', hours: '3' })).status).toBe(400);
      expect((await preview(s, { date: '2027-02-30' })).status).toBe(400);
      expect((await preview(s, { date: 'tomorrow' })).status).toBe(400);
      const weekdays = await makeSlot(t, s.auth, s.venueId, {
        name: 'Weekdays only',
        daysOfWeek: [1, 2, 3, 4],
      });
      const res = await preview(s, { date: '2027-01-02', slotId: weekdays.id });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('date');
    });

    it('404: another tenant venue, space or slot, a space of another venue; 401; 403', async () => {
      const a = await setup();
      const b = await setup();
      expect((await preview(a, { date: '2027-01-04', venueId: b.venueId })).status).toBe(404);
      expect((await preview(a, { date: '2027-01-04', spaceId: b.spaceId })).status).toBe(404);
      expect((await preview(a, { date: '2027-01-04', slotId: b.dinnerId })).status).toBe(404);
      const other = await makeVenue(t, a.auth, { name: 'Elsewhere' });
      expect((await preview(a, { date: '2027-01-04', venueId: other.id })).status).toBe(404);
      expect((await t.http().get('/v1/pricing/rent-preview')).status).toBe(401);
      const none = await setupCaller(world, t, NO_VENUE_ACCESS);
      expect((await preview(a, { date: '2027-01-04' }, none.auth)).status).toBe(403);
    });

    it('404 for a venue the caller is not limited to; allowed for their own', async () => {
      const s = await setup();
      const second = await makeVenue(t, s.auth, { name: 'Second' });
      const scoped = await scopedManagerAuth(world, t, s.tenant, [second.id]);
      expect((await preview(s, { date: '2027-01-04' }, scoped)).status).toBe(404);
      const mine = await scopedManagerAuth(world, t, s.tenant, [s.venueId]);
      expect((await preview(s, { date: '2027-01-04' }, mine)).status).toBe(200);
    });
  });
});
