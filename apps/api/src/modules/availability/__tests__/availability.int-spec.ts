import { AvailabilitySchema } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  bookingWorld,
  createQuotation,
  day,
  heldBooking,
  memberAuth,
  quoteBody,
  session,
} from '../../../__tests__/helpers/booking-fixtures';
import { code } from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

// Module 6: the availability calendar. Spaces x dates x slots with what is held or confirmed, combined-space aware, no prices.

describe('GET /v1/availability', () => {
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

  it('200: lists the grid and only the taken cells, with booking number and customer name', async () => {
    const fx = await bookingWorld(t, world);
    const held = await heldBooking(t, fx, quoteBody(fx, [session(fx, { date: day(1) })]));
    const confirmed = await heldBooking(
      t,
      fx,
      quoteBody(fx, [
        session(fx, { date: day(2), slotId: fx.lunch.id, eventTypeId: fx.mehndi.id }),
      ]),
    );
    await t
      .http()
      .post(`/v1/bookings/${confirmed.id}/confirm`)
      .set(fx.c.auth)
      .send({ rev: confirmed.rev, override: true, reason: 'test' });
    await createQuotation(t, fx, quoteBody(fx, [session(fx, { date: day(3) })])); // a draft never blocks

    const res = await t
      .http()
      .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(0)}&to=${day(6)}`)
      .set(fx.c.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const grid = AvailabilitySchema.parse(res.body);
    expect(grid.timezone).toBeTruthy();
    expect(grid.spaces.map((s) => s.name).sort()).toEqual(['Hall A', 'Hall A+B', 'Hall B']);
    expect(grid.spaces.find((s) => s.name === 'Hall A+B')).toMatchObject({
      isCombined: true,
      componentIds: expect.arrayContaining([fx.hallA.id, fx.hallB.id]),
    });
    expect(grid.slots.map((s) => s.name)).toEqual(['Lunch', 'Dinner']);

    const cell = (spaceId: string, date: string, slotId: string) =>
      grid.cells.find((c) => c.spaceId === spaceId && c.date === date && c.slotId === slotId);
    const dinnerHeld = cell(fx.hallA.id, day(1), fx.dinner.id);
    expect(dinnerHeld).toMatchObject({ status: 'HELD' });
    expect(dinnerHeld?.entries[0]).toMatchObject({
      bookingId: held.id,
      number: held.number,
      customerName: fx.customer.name,
      eventTypeName: 'Barat',
      blockedBy: fx.hallA.id,
    });
    expect(dinnerHeld?.entries[0]?.holdExpiresAt).not.toBeNull();
    const lunchConfirmed = cell(fx.hallA.id, day(2), fx.lunch.id);
    expect(lunchConfirmed).toMatchObject({ status: 'CONFIRMED' });
    expect(lunchConfirmed?.entries[0]?.holdExpiresAt).toBeNull();
    // Free cells and drafts are not listed; neither is another slot of the same day.
    expect(cell(fx.hallA.id, day(3), fx.dinner.id)).toBeUndefined();
    expect(cell(fx.hallA.id, day(1), fx.lunch.id)).toBeUndefined();
    expect(cell(fx.hallB.id, day(1), fx.dinner.id)).toBeUndefined();
    // No prices anywhere in the answer.
    expect(JSON.stringify(res.body)).not.toMatch(/100000|grandTotal|amount/);
  });

  it('is combined-space aware both ways, and shows which space blocks', async () => {
    const fx = await bookingWorld(t, world);
    await heldBooking(t, fx, quoteBody(fx, [session(fx, { spaceId: fx.hallAB.id, date: day(1) })]));
    await heldBooking(t, fx, quoteBody(fx, [session(fx, { spaceId: fx.hallA.id, date: day(2) })]));
    const grid = (
      await t
        .http()
        .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(0)}&to=${day(3)}`)
        .set(fx.c.auth)
    ).body;
    const at = (spaceId: string, date: string) =>
      grid.cells.find(
        (c: { spaceId: string; date: string; slotId: string }) =>
          c.spaceId === spaceId && c.date === date && c.slotId === fx.dinner.id,
      );
    // Hall A+B booked on day 1: both halls and the combined hall are taken.
    for (const space of [fx.hallA, fx.hallB, fx.hallAB])
      expect(at(space.id, day(1)), space.id).toMatchObject({ status: 'HELD' });
    expect(at(fx.hallAB.id, day(1)).entries[0].blockedBy).toBeDefined();
    // Hall A booked on day 2: Hall A and the combined hall are taken, Hall B is free.
    expect(at(fx.hallA.id, day(2))).toMatchObject({ status: 'HELD' });
    expect(at(fx.hallAB.id, day(2))).toMatchObject({ status: 'HELD' });
    expect(at(fx.hallB.id, day(2))).toBeUndefined();
  });

  it('a cancelled or expired booking frees its cells; buffers count as blocked time', async () => {
    const fx = await bookingWorld(t, world, { cleanupBufferMin: 240 });
    const lunch = await heldBooking(
      t,
      fx,
      quoteBody(fx, [session(fx, { slotId: fx.lunch.id, date: day(1) })]),
    );
    const grid = async () =>
      (
        await t
          .http()
          .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(1)}&to=${day(1)}`)
          .set(fx.c.auth)
      ).body.cells;
    // Lunch ends 16:00, 4 h of cleanup blocks the dinner slot starting at 19:00 too.
    // Hall A and (through it) the combined hall, for both slots: 4 cells.
    const taken = await grid();
    expect(taken).toHaveLength(4);
    expect([...new Set(taken.map((c: { slotId: string }) => c.slotId))].sort()).toEqual(
      [fx.lunch.id, fx.dinner.id].sort(),
    );
    await t
      .http()
      .post(`/v1/bookings/${lunch.id}/cancel`)
      .set(fx.c.auth)
      .send({ rev: lunch.rev, reason: 'Gave it up' });
    expect(await grid()).toEqual([]);
  });

  it('weekdays: a slot that is not offered on a day has no cells that day', async () => {
    const fx = await bookingWorld(t, world);
    const sundays = await t
      .http()
      .post('/v1/slot-templates')
      .set(fx.c.auth)
      .send({
        venueId: fx.venue.id,
        name: 'Sunday brunch',
        mode: 'FIXED',
        startTime: '09:00',
        endTime: '11:00',
        daysOfWeek: [0],
      });
    expect(sundays.status).toBe(201);
    const grid = (
      await t
        .http()
        .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(0)}&to=${day(0)}`)
        .set(fx.c.auth)
    ).body;
    expect(grid.slots.find((s: { name: string }) => s.name === 'Sunday brunch').daysOfWeek).toEqual(
      [0],
    );
  });

  it('400 for a range over 62 days, a backwards range or a bad date; 404 for a venue of another workspace; 401; 403', async () => {
    const fx = await bookingWorld(t, world);
    const other = await bookingWorld(t, world);
    const get = (q: string, auth = fx.c.auth) => t.http().get(`/v1/availability?${q}`).set(auth);
    expect((await get(`venueId=${fx.venue.id}&from=2031-01-01&to=2031-03-05`)).status).toBe(400); // 64 days
    expect((await get(`venueId=${fx.venue.id}&from=2031-01-01&to=2031-03-03`)).status).toBe(200); // 62 days
    expect((await get(`venueId=${fx.venue.id}&from=2031-01-05&to=2031-01-01`)).status).toBe(400);
    expect((await get(`venueId=${fx.venue.id}&from=2031-02-30&to=2031-03-01`)).status).toBe(400);
    expect((await get(`venueId=${fx.venue.id}&from=2031-01-01`)).status).toBe(400);
    const foreign = await get(`venueId=${other.venue.id}&from=${day(0)}&to=${day(1)}`);
    expect(foreign.status).toBe(404);
    expect(code(foreign)).toBe('NOT_FOUND');
    expect(
      (
        await t
          .http()
          .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(0)}&to=${day(1)}`)
          .set(t.csrfHeaders)
      ).status,
    ).toBe(401);
    const nobody = await world.addMember(fx.c.tenant, { role: { permissions: ['venue.view'] } });
    expect(
      (await get(`venueId=${fx.venue.id}&from=${day(0)}&to=${day(1)}`, memberAuth(t, nobody, fx.c)))
        .status,
    ).toBe(403);
    // A caller limited to another venue gets 404, one limited to this venue 200.
    const second = await t.http().post('/v1/venues').set(fx.c.auth).send({ name: 'Other Hall' });
    const scoped = await world.addMember(fx.c.tenant, {
      role: 'branch_manager',
      venueIds: [second.body.id],
    });
    expect(
      (await get(`venueId=${fx.venue.id}&from=${day(0)}&to=${day(1)}`, memberAuth(t, scoped, fx.c)))
        .status,
    ).toBe(404);
    const mine = await world.addMember(fx.c.tenant, {
      role: 'operations',
      venueIds: [fx.venue.id],
    });
    expect(
      (await get(`venueId=${fx.venue.id}&from=${day(0)}&to=${day(1)}`, memberAuth(t, mine, fx.c)))
        .status,
    ).toBe(200);
  });

  it("another workspace's bookings never show up", async () => {
    const fx = await bookingWorld(t, world);
    const other = await bookingWorld(t, world);
    await heldBooking(t, other);
    const grid = (
      await t
        .http()
        .get(`/v1/availability?venueId=${fx.venue.id}&from=${day(0)}&to=${day(1)}`)
        .set(fx.c.auth)
    ).body;
    expect(grid.cells).toEqual([]);
  });
});
