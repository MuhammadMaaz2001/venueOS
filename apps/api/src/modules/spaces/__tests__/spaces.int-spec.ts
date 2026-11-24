import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SpaceListResponseSchema,
  SpaceSchema,
  SpaceSlotPricesResponseSchema,
} from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  code,
  makeSlot,
  makeSpace,
  makeVenue,
  scopedManagerAuth,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

describe('spaces endpoints', () => {
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

  describe('POST /v1/spaces', () => {
    it('201: creates a space with a rent in the tenant currency (PKR, 2 decimals) and audits it', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const res = await t.http().post('/v1/spaces').set(auth).send({
        venueId: venue.id,
        name: 'Main Hall',
        kind: 'HALL',
        capacitySeated: 500,
        capacityStanding: 800,
        minGuests: 100,
        setupBufferMin: 60,
        cleanupBufferMin: 30,
        baseRent: '150000',
      });
      expect(res.status).toBe(201);
      const space = SpaceSchema.parse(res.body);
      expect(space).toMatchObject({
        venueId: venue.id,
        name: 'Main Hall',
        isCombined: false,
        componentIds: [],
        baseRent: '150000.00',
        setupBufferMin: 60,
        rev: 1,
      });
      expect(
        await world.auditRows(tenant, { action: 'space.create', entityId: space.id }),
      ).toHaveLength(1);
    });

    it('400: bad input (no name, negative capacity, 3 decimals in PKR, combined without components)', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const post = (body: Record<string, unknown>) =>
        t
          .http()
          .post('/v1/spaces')
          .set(auth)
          .send({ venueId: venue.id, ...body });
      expect((await post({})).status).toBe(400);
      expect((await post({ name: 'X', capacitySeated: -5 })).status).toBe(400);
      const decimals = await post({ name: 'X', baseRent: '10.005' });
      expect(decimals.status).toBe(400);
      expect(code(decimals)).toBe('VALIDATION_ERROR');
      expect((await post({ name: 'X', isCombined: true })).status).toBe(400);
      expect((await post({ name: 'X', componentIds: ['a', 'b'] })).status).toBe(400);
    });

    it('403: without venue.manage', async () => {
      const a = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      const res = await t
        .http()
        .post('/v1/spaces')
        .set(agent.auth)
        .send({ venueId: venue.id, name: 'X' });
      expect(res.status).toBe(403);
    });

    it("404: another tenant's venue, and a venue outside my scope", async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const theirs = await makeVenue(t, b.auth);
      const res = await t
        .http()
        .post('/v1/spaces')
        .set(a.auth)
        .send({ venueId: theirs.id, name: 'Hijack' });
      expect(res.status).toBe(404);

      const mine = await makeVenue(t, a.auth);
      const other = await makeVenue(t, a.auth, { name: 'Other' });
      const scoped = await scopedManagerAuth(world, t, a.tenant, [mine.id]);
      const outside = await t
        .http()
        .post('/v1/spaces')
        .set(scoped)
        .send({ venueId: other.id, name: 'X' });
      expect(outside.status).toBe(404);
    });

    it('402: at the plan limit (starter = 3 spaces)', async () => {
      const { auth } = await setupCaller(world, t, { plan: 'starter' });
      const venue = await makeVenue(t, auth);
      for (const name of ['A', 'B', 'C']) await makeSpace(t, auth, venue.id, { name });
      const res = await t
        .http()
        .post('/v1/spaces')
        .set(auth)
        .send({ venueId: venue.id, name: 'D' });
      expect(res.status).toBe(402);
      expect(code(res)).toBe('PLAN_LIMIT_REACHED');
    });

    it('422: a deactivated venue takes no new space', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      await t.http().patch(`/v1/venues/${venue.id}`).set(auth).send({ rev: 1, active: false });
      const res = await t
        .http()
        .post('/v1/spaces')
        .set(auth)
        .send({ venueId: venue.id, name: 'X' });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('combined spaces', () => {
    it('201: Hall A+B is made of two physical spaces of the venue', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const a = await makeSpace(t, auth, venue.id, { name: 'Hall A' });
      const b = await makeSpace(t, auth, venue.id, { name: 'Hall B' });
      const combined = await makeSpace(t, auth, venue.id, {
        name: 'Hall A+B',
        isCombined: true,
        componentIds: [b.id, a.id],
      });
      expect(combined.isCombined).toBe(true);
      expect(combined.componentIds).toEqual([a.id, b.id].sort());
    });

    it('400/404/400: unknown component, other venue, nested combined', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const other = await makeVenue(t, auth, { name: 'Other' });
      const a = await makeSpace(t, auth, venue.id, { name: 'A' });
      const b = await makeSpace(t, auth, venue.id, { name: 'B' });
      const c = await makeSpace(t, auth, other.id, { name: 'C' });
      const create = (componentIds: string[], name = 'Combo') =>
        t
          .http()
          .post('/v1/spaces')
          .set(auth)
          .send({ venueId: venue.id, name, isCombined: true, componentIds });

      expect((await create([a.id, 'does-not-exist'])).status).toBe(404);
      const crossVenue = await create([a.id, c.id]);
      expect(crossVenue.status).toBe(400);
      expect(crossVenue.body.error.details[0].path).toBe('componentIds');

      const ok = await create([a.id, b.id]);
      expect(ok.status).toBe(201);
      const nested = await create([ok.body.id, a.id], 'Nested');
      expect(nested.status).toBe(400);
    });

    it("404: a component of another tenant's venue", async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const mine = await makeSpace(t, a.auth, venue.id, { name: 'Mine' });
      const theirVenue = await makeVenue(t, b.auth);
      const theirs = await makeSpace(t, b.auth, theirVenue.id, { name: 'Theirs' });
      const res = await t
        .http()
        .post('/v1/spaces')
        .set(a.auth)
        .send({
          venueId: venue.id,
          name: 'Combo',
          isCombined: true,
          componentIds: [mine.id, theirs.id],
        });
      expect(res.status).toBe(404);
    });

    it('PATCH replaces components (rev moves), a component of an active combined space cannot be deactivated', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const a = await makeSpace(t, auth, venue.id, { name: 'A' });
      const b = await makeSpace(t, auth, venue.id, { name: 'B' });
      const c = await makeSpace(t, auth, venue.id, { name: 'C' });
      const combined = await makeSpace(t, auth, venue.id, {
        name: 'A+B',
        isCombined: true,
        componentIds: [a.id, b.id],
      });

      const blocked = await t
        .http()
        .patch(`/v1/spaces/${a.id}`)
        .set(auth)
        .send({ rev: a.rev, active: false });
      expect(blocked.status).toBe(422);

      const res = await t
        .http()
        .patch(`/v1/spaces/${combined.id}`)
        .set(auth)
        .send({ rev: combined.rev, componentIds: [b.id, c.id] });
      expect(res.status).toBe(200);
      expect(res.body.componentIds).toEqual([b.id, c.id].sort());
      expect(res.body.rev).toBe(combined.rev + 1);

      const nowFree = await t
        .http()
        .patch(`/v1/spaces/${a.id}`)
        .set(auth)
        .send({ rev: a.rev, active: false });
      expect(nowFree.status).toBe(200);

      const physical = await t
        .http()
        .patch(`/v1/spaces/${b.id}`)
        .set(auth)
        .send({ rev: b.rev, componentIds: [a.id, c.id] });
      expect(physical.status).toBe(400);
    });
  });

  describe('GET /v1/spaces and /v1/spaces/:id', () => {
    it('200: filters by venue, hides inactive, never lists another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const v1 = await makeVenue(t, a.auth, { name: 'V1' });
      const v2 = await makeVenue(t, a.auth, { name: 'V2' });
      const s1 = await makeSpace(t, a.auth, v1.id, { name: 'S1' });
      await makeSpace(t, a.auth, v2.id, { name: 'S2' });
      const gone = await makeSpace(t, a.auth, v1.id, { name: 'Gone' });
      await t.http().patch(`/v1/spaces/${gone.id}`).set(a.auth).send({ rev: 1, active: false });
      const theirVenue = await makeVenue(t, b.auth);
      await makeSpace(t, b.auth, theirVenue.id, { name: 'Theirs' });

      const all = await t.http().get('/v1/spaces').set(a.auth);
      expect(all.body.data.map((s: { name: string }) => s.name)).toEqual(['S1', 'S2']);
      const one = await t.http().get(`/v1/spaces?venueId=${v1.id}`).set(a.auth);
      expect(SpaceListResponseSchema.parse(one.body).data.map((s) => s.id)).toEqual([s1.id]);
      const withInactive = await t
        .http()
        .get(`/v1/spaces?venueId=${v1.id}&includeInactive=true`)
        .set(a.auth);
      expect(withInactive.body.data).toHaveLength(2);
      // Asking for another tenant's venue only narrows: empty, not an error.
      const foreign = await t.http().get(`/v1/spaces?venueId=${theirVenue.id}`).set(a.auth);
      expect(foreign.status).toBe(200);
      expect(foreign.body.data).toEqual([]);
    });

    it('200 / 404 / 403 on the single space', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const space = await makeSpace(t, a.auth, venue.id);
      expect((await t.http().get(`/v1/spaces/${space.id}`).set(a.auth)).status).toBe(200);
      expect((await t.http().get(`/v1/spaces/${space.id}`).set(b.auth)).status).toBe(404);
      const agent = await setupCaller(world, t, { role: { role: 'operations' } });
      expect((await t.http().get(`/v1/spaces/${space.id}`).set(agent.auth)).status).toBe(403);
    });
  });

  describe('PATCH /v1/spaces/:id', () => {
    it('200: edits, converts the rent to the currency decimals, audits', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const space = await makeSpace(t, auth, venue.id);
      const res = await t
        .http()
        .patch(`/v1/spaces/${space.id}`)
        .set(auth)
        .send({ rev: space.rev, name: 'Renamed', baseRent: '99999.5', capacityStanding: null });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        baseRent: '99999.50',
        capacityStanding: null,
      });
      expect(
        await world.auditRows(tenant, { action: 'space.update', entityId: space.id }),
      ).toHaveLength(1);
    });

    it('409 stale rev, 400 invalid, 403 without permission, 404 other tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const space = await makeSpace(t, a.auth, venue.id);
      const path = `/v1/spaces/${space.id}`;
      await t.http().patch(path).set(a.auth).send({ rev: space.rev, name: 'One' });
      const stale = await t.http().patch(path).set(a.auth).send({ rev: space.rev, name: 'Two' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect(
        (await t.http().patch(path).set(a.auth).send({ rev: 2, setupBufferMin: -1 })).status,
      ).toBe(400);
      expect((await t.http().patch(path).set(a.auth).send({ rev: 2 })).status).toBe(400);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      expect((await t.http().patch(path).set(agent.auth).send({ rev: 2, name: 'X' })).status).toBe(
        403,
      );
      expect((await t.http().patch(path).set(b.auth).send({ rev: 2, name: 'X' })).status).toBe(404);
    });

    it('402: reactivating a space over the limit; 200 below it', async () => {
      const { auth } = await setupCaller(world, t, { plan: 'starter' });
      const venue = await makeVenue(t, auth);
      const a = await makeSpace(t, auth, venue.id, { name: 'A' });
      await makeSpace(t, auth, venue.id, { name: 'B' });
      await makeSpace(t, auth, venue.id, { name: 'C' });
      const off = await t
        .http()
        .patch(`/v1/spaces/${a.id}`)
        .set(auth)
        .send({ rev: 1, active: false });
      expect(off.status).toBe(200);
      await makeSpace(t, auth, venue.id, { name: 'D' });
      const back = await t
        .http()
        .patch(`/v1/spaces/${a.id}`)
        .set(auth)
        .send({ rev: off.body.rev, active: true });
      expect(back.status).toBe(402);
    });
  });

  describe('slot prices: GET/PUT /v1/spaces/:id/slot-prices', () => {
    async function world1() {
      const caller = await setupCaller(world, t);
      const venue = await makeVenue(t, caller.auth);
      const space = await makeSpace(t, caller.auth, venue.id);
      const lunch = await makeSlot(t, caller.auth, venue.id, { name: 'Lunch' });
      const dinner = await makeSlot(t, caller.auth, venue.id, {
        name: 'Dinner',
        startTime: '19:00',
        endTime: '23:30',
      });
      return { ...caller, venue, space, lunch, dinner };
    }

    it('200: replaces the price list, formats to the currency, audits, and a second PUT replaces again', async () => {
      const { auth, tenant, space, lunch, dinner } = await world1();
      const path = `/v1/spaces/${space.id}/slot-prices`;
      expect(
        SpaceSlotPricesResponseSchema.parse((await t.http().get(path).set(auth)).body).data,
      ).toEqual([]);

      const put = await t
        .http()
        .put(path)
        .set(auth)
        .send({
          prices: [
            { slotId: lunch.id, rent: '120000' },
            { slotId: dinner.id, rent: '180000.5' },
          ],
        });
      expect(put.status).toBe(200);
      const byId = Object.fromEntries(
        put.body.data.map((p: { slotId: string; rent: string }) => [p.slotId, p.rent]),
      );
      expect(byId).toEqual({ [lunch.id]: '120000.00', [dinner.id]: '180000.50' });

      const replaced = await t
        .http()
        .put(path)
        .set(auth)
        .send({ prices: [{ slotId: dinner.id, rent: '1' }] });
      expect(replaced.body.data).toEqual([{ slotId: dinner.id, rent: '1.00' }]);
      expect(
        await world.auditRows(tenant, { action: 'space.slot_prices.replace', entityId: space.id }),
      ).toHaveLength(2);
    });

    it('400: bad amount, duplicate slot; 404: unknown slot; 400: slot of another venue', async () => {
      const { auth, space, lunch, venue } = await world1();
      const path = `/v1/spaces/${space.id}/slot-prices`;
      expect(
        (
          await t
            .http()
            .put(path)
            .set(auth)
            .send({ prices: [{ slotId: lunch.id, rent: '-5' }] })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .put(path)
            .set(auth)
            .send({ prices: [{ slotId: lunch.id, rent: '1.234' }] })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .put(path)
            .set(auth)
            .send({
              prices: [
                { slotId: lunch.id, rent: '1' },
                { slotId: lunch.id, rent: '2' },
              ],
            })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .put(path)
            .set(auth)
            .send({ prices: [{ slotId: 'nope', rent: '1' }] })
        ).status,
      ).toBe(404);

      const otherVenue = await makeVenue(t, auth, { name: 'Other' });
      const foreignSlot = await makeSlot(t, auth, otherVenue.id, { name: 'Elsewhere' });
      expect(venue.id).not.toBe(otherVenue.id);
      const cross = await t
        .http()
        .put(path)
        .set(auth)
        .send({ prices: [{ slotId: foreignSlot.id, rent: '1' }] });
      expect(cross.status).toBe(400);
    });

    it("403 without permission; 404 for another tenant's space and for another tenant's slot", async () => {
      const a = await world1();
      const b = await world1();
      const path = `/v1/spaces/${a.space.id}/slot-prices`;
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      expect((await t.http().get(path).set(agent.auth)).status).toBe(403);
      expect((await t.http().put(path).set(agent.auth).send({ prices: [] })).status).toBe(403);
      expect((await t.http().get(path).set(b.auth)).status).toBe(404);
      expect((await t.http().put(path).set(b.auth).send({ prices: [] })).status).toBe(404);
      const theirSlot = await t
        .http()
        .put(path)
        .set(a.auth)
        .send({ prices: [{ slotId: b.lunch.id, rent: '1' }] });
      expect(theirSlot.status).toBe(404);
    });
  });
});
