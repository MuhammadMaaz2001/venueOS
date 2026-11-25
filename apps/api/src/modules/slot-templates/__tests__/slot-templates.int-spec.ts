import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SlotTemplateSchema } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  code,
  makeSlot,
  makeVenue,
  scopedManagerAuth,
  NO_VENUE_ACCESS,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

describe('slot template endpoints', () => {
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

  describe('POST /v1/slot-templates', () => {
    it('201: FIXED Lunch and an overnight Dinner, days sorted, audited', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const lunch = await makeSlot(t, auth, venue.id, { daysOfWeek: [5, 0, 6] });
      expect(SlotTemplateSchema.parse(lunch)).toMatchObject({
        name: 'Lunch',
        mode: 'FIXED',
        startTime: '12:00',
        endTime: '16:00',
        daysOfWeek: [0, 5, 6],
        minHours: null,
        rev: 1,
      });
      const late = await makeSlot(t, auth, venue.id, {
        name: 'Late night',
        startTime: '22:00',
        endTime: '02:00',
      });
      expect(late.endTime).toBe('02:00');
      expect(
        await world.auditRows(tenant, { action: 'slot_template.create', entityId: lunch.id }),
      ).toHaveLength(1);
    });

    it('201: FULL_DAY has no times of its own; HOURLY follows the venue opening hours', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth, { opensAt: '10:00', closesAt: '02:00' });
      const full = await makeSlot(t, auth, venue.id, {
        name: 'Full day',
        mode: 'FULL_DAY',
        startTime: undefined,
        endTime: undefined,
      });
      expect(full).toMatchObject({ mode: 'FULL_DAY', startTime: '00:00', endTime: '00:00' });

      const hourly = await makeSlot(t, auth, venue.id, {
        name: 'Hourly',
        mode: 'HOURLY',
        startTime: undefined,
        endTime: undefined,
        minHours: 3,
      });
      expect(hourly).toMatchObject({
        mode: 'HOURLY',
        startTime: '10:00',
        endTime: '02:00',
        minHours: 3,
      });
    });

    it('400: FIXED without times, equal times, minHours on a FIXED slot, times on FULL_DAY, bad day', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const post = (body: Record<string, unknown>) =>
        t
          .http()
          .post('/v1/slot-templates')
          .set(auth)
          .send({ venueId: venue.id, ...body });
      expect((await post({ name: 'X', mode: 'FIXED' })).status).toBe(400);
      expect(
        (await post({ name: 'X', mode: 'FIXED', startTime: '12:00', endTime: '12:00' })).status,
      ).toBe(400);
      expect(
        (
          await post({
            name: 'X',
            mode: 'FIXED',
            startTime: '12:00',
            endTime: '16:00',
            minHours: 2,
          })
        ).status,
      ).toBe(400);
      expect(
        (await post({ name: 'X', mode: 'FULL_DAY', startTime: '10:00', endTime: '12:00' })).status,
      ).toBe(400);
      expect(
        (
          await post({
            name: 'X',
            mode: 'FIXED',
            startTime: '12:00',
            endTime: '16:00',
            daysOfWeek: [7],
          })
        ).status,
      ).toBe(400);
      const res = await post({ name: 'X', mode: 'NOPE' });
      expect(code(res)).toBe('VALIDATION_ERROR');
    });

    it('400: an HOURLY window outside the opening hours, or shorter than the minimum', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth, { opensAt: '10:00', closesAt: '23:00' });
      const post = (body: Record<string, unknown>) =>
        t
          .http()
          .post('/v1/slot-templates')
          .set(auth)
          .send({ venueId: venue.id, name: 'H', mode: 'HOURLY', ...body });
      expect((await post({ startTime: '08:00', endTime: '12:00' })).status).toBe(400);
      expect((await post({ startTime: '10:00', endTime: '12:00', minHours: 4 })).status).toBe(400);
      expect((await post({ startTime: '12:00', endTime: '20:00', minHours: 4 })).status).toBe(201);
    });

    it('409: the same name twice in one venue (case-insensitive), fine in another venue', async () => {
      const { auth } = await setupCaller(world, t);
      const v1 = await makeVenue(t, auth);
      const v2 = await makeVenue(t, auth, { name: 'Other' });
      await makeSlot(t, auth, v1.id);
      const dup = await t.http().post('/v1/slot-templates').set(auth).send({
        venueId: v1.id,
        name: 'LUNCH',
        mode: 'FIXED',
        startTime: '13:00',
        endTime: '15:00',
      });
      expect(dup.status).toBe(409);
      expect(code(dup)).toBe('DUPLICATE');
      await makeSlot(t, auth, v2.id);
    });

    it('403 without venue.manage; 404 for another tenant venue and a venue outside my scope', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const other = await makeVenue(t, a.auth, { name: 'Other' });
      const body = { name: 'X', mode: 'FIXED', startTime: '12:00', endTime: '16:00' };
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      expect(
        (
          await t
            .http()
            .post('/v1/slot-templates')
            .set(agent.auth)
            .send({ venueId: venue.id, ...body })
        ).status,
      ).toBe(403);
      expect(
        (
          await t
            .http()
            .post('/v1/slot-templates')
            .set(b.auth)
            .send({ venueId: venue.id, ...body })
        ).status,
      ).toBe(404);
      const scoped = await scopedManagerAuth(world, t, a.tenant, [venue.id]);
      expect(
        (
          await t
            .http()
            .post('/v1/slot-templates')
            .set(scoped)
            .send({ venueId: other.id, ...body })
        ).status,
      ).toBe(404);
    });
  });

  describe('GET', () => {
    it('200: list by venue, inactive on request; single slot; 404 for another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const v1 = await makeVenue(t, a.auth);
      const v2 = await makeVenue(t, a.auth, { name: 'V2' });
      const dinner = await makeSlot(t, a.auth, v1.id, {
        name: 'Dinner',
        startTime: '19:00',
        endTime: '23:30',
      });
      const lunch = await makeSlot(t, a.auth, v1.id);
      await makeSlot(t, a.auth, v2.id, { name: 'Elsewhere' });
      const gone = await makeSlot(t, a.auth, v1.id, {
        name: 'Gone',
        startTime: '06:00',
        endTime: '09:00',
      });
      await t
        .http()
        .patch(`/v1/slot-templates/${gone.id}`)
        .set(a.auth)
        .send({ rev: 1, active: false });

      const list = await t.http().get(`/v1/slot-templates?venueId=${v1.id}`).set(a.auth);
      expect(list.status).toBe(200);
      expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([lunch.id, dinner.id]);
      const all = await t.http().get('/v1/slot-templates?includeInactive=true').set(a.auth);
      expect(all.body.data).toHaveLength(4);

      expect((await t.http().get(`/v1/slot-templates/${lunch.id}`).set(a.auth)).status).toBe(200);
      expect((await t.http().get(`/v1/slot-templates/${lunch.id}`).set(b.auth)).status).toBe(404);
      const agent = await setupCaller(world, t, NO_VENUE_ACCESS);
      expect((await t.http().get('/v1/slot-templates').set(agent.auth)).status).toBe(403);
    });
  });

  describe('PATCH /v1/slot-templates/:id', () => {
    it('200: renames, moves the times, audits; rev bumps', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const slot = await makeSlot(t, auth, venue.id);
      const res = await t
        .http()
        .patch(`/v1/slot-templates/${slot.id}`)
        .set(auth)
        .send({ rev: slot.rev, name: 'Brunch', startTime: '11:00', endTime: '14:00' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Brunch',
        startTime: '11:00',
        endTime: '14:00',
        rev: slot.rev + 1,
      });
      expect(
        await world.auditRows(tenant, { action: 'slot_template.update', entityId: slot.id }),
      ).toHaveLength(1);
    });

    it('409 stale rev / duplicate name; 400 nothing to change, times on FULL_DAY, minHours on FIXED', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const lunch = await makeSlot(t, auth, venue.id);
      const dinner = await makeSlot(t, auth, venue.id, {
        name: 'Dinner',
        startTime: '19:00',
        endTime: '23:30',
      });
      const full = await makeSlot(t, auth, venue.id, {
        name: 'Day',
        mode: 'FULL_DAY',
        startTime: undefined,
        endTime: undefined,
      });
      const patch = (id: string, body: Record<string, unknown>) =>
        t.http().patch(`/v1/slot-templates/${id}`).set(auth).send(body);

      await patch(lunch.id, { rev: 1, name: 'Lunch 2' });
      const stale = await patch(lunch.id, { rev: 1, name: 'Lunch 3' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect((await patch(dinner.id, { rev: 1, name: 'lunch 2' })).status).toBe(409);
      expect((await patch(dinner.id, { rev: 1 })).status).toBe(400);
      expect((await patch(full.id, { rev: 1, startTime: '10:00' })).status).toBe(400);
      expect((await patch(dinner.id, { rev: 1, minHours: 2 })).status).toBe(400);
    });

    it('403 without permission; 404 for another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const slot = await makeSlot(t, a.auth, venue.id);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      const path = `/v1/slot-templates/${slot.id}`;
      expect((await t.http().patch(path).set(agent.auth).send({ rev: 1, name: 'X' })).status).toBe(
        403,
      );
      expect((await t.http().patch(path).set(b.auth).send({ rev: 1, name: 'X' })).status).toBe(404);
    });
  });
});
