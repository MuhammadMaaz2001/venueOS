import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VenueListResponseSchema, VenueSchema } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  code,
  makeVenue,
  scopedManagerAuth,
  NO_VENUE_ACCESS,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

describe('venues endpoints', () => {
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

  describe('POST /v1/venues', () => {
    it('201: creates a venue with opening hours and audits it', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const res = await t
        .http()
        .post('/v1/venues')
        .set(auth)
        .send({
          name: ' Grand Marquee ',
          city: 'Lahore',
          address: '',
          opensAt: '10:00',
          closesAt: '02:00',
          localRules: { latestEndTime: '23:30', maxGuests: 800 },
        });
      expect(res.status).toBe(201);
      const venue = VenueSchema.parse(res.body);
      expect(venue).toMatchObject({
        name: 'Grand Marquee',
        city: 'Lahore',
        address: null,
        opensAt: '10:00',
        closesAt: '02:00',
        active: true,
        rev: 1,
        localRules: { latestEndTime: '23:30', maxGuests: 800 },
      });
      const audit = await world.auditRows(tenant, { action: 'venue.create', entityId: venue.id });
      expect(audit).toHaveLength(1);
    });

    it('400: rejects an empty name, a bad time and a half-set opening window', async () => {
      const { auth } = await setupCaller(world, t);
      const empty = await t.http().post('/v1/venues').set(auth).send({ name: '  ' });
      expect(empty.status).toBe(400);
      expect(code(empty)).toBe('VALIDATION_ERROR');
      const badTime = await t
        .http()
        .post('/v1/venues')
        .set(auth)
        .send({ name: 'X', opensAt: '25:00', closesAt: '10:00' });
      expect(badTime.status).toBe(400);
      const half = await t
        .http()
        .post('/v1/venues')
        .set(auth)
        .send({ name: 'X', opensAt: '10:00' });
      expect(half.status).toBe(400);
      const badZone = await t
        .http()
        .post('/v1/venues')
        .set(auth)
        .send({ name: 'X', timezone: 'Mars/Base' });
      expect(badZone.status).toBe(400);
    });

    it('403: without venue.manage', async () => {
      const { auth } = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      const res = await t.http().post('/v1/venues').set(auth).send({ name: 'X' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('403: a caller limited to some venues cannot add a venue', async () => {
      const caller = await setupCaller(world, t);
      const venue = await makeVenue(t, caller.ownerAuth);
      const auth = await scopedManagerAuth(world, t, caller.tenant, [venue.id]);
      const res = await t.http().post('/v1/venues').set(auth).send({ name: 'Second' });
      expect(res.status).toBe(403);
    });

    it('402: at the plan limit (starter = 1 venue)', async () => {
      const { auth } = await setupCaller(world, t, { plan: 'starter' });
      await makeVenue(t, auth);
      const res = await t.http().post('/v1/venues').set(auth).send({ name: 'Second' });
      expect(res.status).toBe(402);
      expect(code(res)).toBe('PLAN_LIMIT_REACHED');
    });

    it('402: a tenant without a subscription has no allowance', async () => {
      const { auth } = await setupCaller(world, t, { plan: null });
      const res = await t.http().post('/v1/venues').set(auth).send({ name: 'X' });
      expect(res.status).toBe(402);
    });

    it('403: a suspended workspace is read-only', async () => {
      const { auth } = await setupCaller(world, t, { status: 'SUSPENDED' });
      const res = await t.http().post('/v1/venues').set(auth).send({ name: 'X' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('TENANT_SUSPENDED');
    });
  });

  describe('GET /v1/venues', () => {
    it('200: lists active venues, inactive only on request, never another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const v1 = await makeVenue(t, a.auth, { name: 'Alpha' });
      const v2 = await makeVenue(t, a.auth, { name: 'Beta' });
      await makeVenue(t, b.auth, { name: 'Other tenant' });
      const off = await t
        .http()
        .patch(`/v1/venues/${v2.id}`)
        .set(a.auth)
        .send({ rev: v2.rev, active: false });
      expect(off.status).toBe(200);

      const list = await t.http().get('/v1/venues').set(a.auth);
      expect(list.status).toBe(200);
      expect(VenueListResponseSchema.parse(list.body).data.map((v) => v.id)).toEqual([v1.id]);

      const all = await t.http().get('/v1/venues?includeInactive=true').set(a.auth);
      expect(all.body.data.map((v: { name: string }) => v.name)).toEqual(['Alpha', 'Beta']);
    });

    it('200: a caller limited to some venues only sees those', async () => {
      const caller = await setupCaller(world, t);
      const v1 = await makeVenue(t, caller.ownerAuth, { name: 'Mine' });
      await makeVenue(t, caller.ownerAuth, { name: 'Not mine' });
      const auth = await scopedManagerAuth(world, t, caller.tenant, [v1.id]);
      const list = await t.http().get('/v1/venues').set(auth);
      expect(list.body.data.map((v: { id: string }) => v.id)).toEqual([v1.id]);
    });

    it('403: without venue.view', async () => {
      const { auth } = await setupCaller(world, t, NO_VENUE_ACCESS);
      expect((await t.http().get('/v1/venues').set(auth)).status).toBe(403);
    });
  });

  describe('GET /v1/venues/:id', () => {
    it('200 / 404: own venue, another tenant, unknown id, venue outside my scope', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const mine = await makeVenue(t, a.auth);
      const theirs = await makeVenue(t, b.auth);
      expect((await t.http().get(`/v1/venues/${mine.id}`).set(a.auth)).status).toBe(200);
      const other = await t.http().get(`/v1/venues/${theirs.id}`).set(a.auth);
      expect(other.status).toBe(404);
      expect(code(other)).toBe('NOT_FOUND');
      expect((await t.http().get('/v1/venues/nope').set(a.auth)).status).toBe(404);

      const second = await makeVenue(t, a.auth, { name: 'Second' });
      const scoped = await scopedManagerAuth(world, t, a.tenant, [mine.id]);
      const res = await t.http().get(`/v1/venues/${second.id}`).set(scoped);
      expect(res.status).toBe(404);
    });

    it('403: without venue.view', async () => {
      const a = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const agent = await setupCaller(world, t, NO_VENUE_ACCESS);
      expect((await t.http().get(`/v1/venues/${venue.id}`).set(agent.auth)).status).toBe(403);
    });
  });

  describe('PATCH /v1/venues/:id', () => {
    it('200: changes fields, bumps rev, audits before and after', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const res = await t.http().patch(`/v1/venues/${venue.id}`).set(auth).send({
        rev: venue.rev,
        name: 'Renamed',
        city: 'Karachi',
        opensAt: '09:00',
        closesAt: '23:00',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        city: 'Karachi',
        opensAt: '09:00',
        rev: venue.rev + 1,
      });
      const audit = await world.auditRows(tenant, { action: 'venue.update', entityId: venue.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.before).toMatchObject({ name: 'Grand Hall' });
      expect(audit[0]?.after).toMatchObject({ name: 'Renamed' });
    });

    it('409: a stale rev', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(auth)
        .send({ rev: venue.rev, name: 'One' });
      const stale = await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(auth)
        .send({ rev: venue.rev, name: 'Two' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
    });

    it('400: no rev, nothing to change, half-set hours against the stored venue', async () => {
      const { auth } = await setupCaller(world, t);
      const venue = await makeVenue(t, auth);
      const path = `/v1/venues/${venue.id}`;
      expect((await t.http().patch(path).set(auth).send({ name: 'X' })).status).toBe(400);
      expect((await t.http().patch(path).set(auth).send({ rev: 1 })).status).toBe(400);
      const half = await t.http().patch(path).set(auth).send({ rev: 1, opensAt: '10:00' });
      expect(half.status).toBe(400);
      expect(code(half)).toBe('VALIDATION_ERROR');
    });

    it('200: active=false hides the venue (soft delete), true brings it back within the plan', async () => {
      const { auth } = await setupCaller(world, t, { plan: 'starter' });
      const venue = await makeVenue(t, auth);
      const off = await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(auth)
        .send({ rev: venue.rev, active: false });
      expect(off.body.active).toBe(false);
      // The freed seat lets a new venue in; bringing the old one back is then over the limit.
      const second = await makeVenue(t, auth, { name: 'Second' });
      expect(second.active).toBe(true);
      const back = await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(auth)
        .send({ rev: off.body.rev, active: true });
      expect(back.status).toBe(402);
    });

    it('403: without venue.manage; 404: another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const venue = await makeVenue(t, a.auth);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      const denied = await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(agent.auth)
        .send({ rev: 1, name: 'X' });
      expect(denied.status).toBe(403);
      const other = await t
        .http()
        .patch(`/v1/venues/${venue.id}`)
        .set(b.auth)
        .send({ rev: 1, name: 'Hijack' });
      expect(other.status).toBe(404);
      const still = await t.http().get(`/v1/venues/${venue.id}`).set(a.auth);
      expect(still.body.name).toBe('Grand Hall');
    });
  });
});
