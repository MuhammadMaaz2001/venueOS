import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventTypeSchema } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  code,
  makeEventType,
  makeVenue,
  scopedManagerAuth,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

describe('event type endpoints', () => {
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

  describe('POST /v1/event-types', () => {
    it('201: creates and audits; the same name in two tenants is fine', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const created = await makeEventType(t, a.auth, { name: 'Mehndi', color: '#FF8800' });
      expect(EventTypeSchema.parse(created)).toMatchObject({
        name: 'Mehndi',
        color: '#FF8800',
        active: true,
        rev: 1,
      });
      expect(
        await world.auditRows(a.tenant, { action: 'event_type.create', entityId: created.id }),
      ).toHaveLength(1);
      await makeEventType(t, b.auth, { name: 'Mehndi' });
    });

    it('400: empty name, bad colour', async () => {
      const { auth } = await setupCaller(world, t);
      const empty = await t.http().post('/v1/event-types').set(auth).send({ name: ' ' });
      expect(empty.status).toBe(400);
      expect(code(empty)).toBe('VALIDATION_ERROR');
      const colour = await t
        .http()
        .post('/v1/event-types')
        .set(auth)
        .send({ name: 'X', color: 'red' });
      expect(colour.status).toBe(400);
    });

    it('409: duplicate name in the tenant', async () => {
      const { auth } = await setupCaller(world, t);
      await makeEventType(t, auth, { name: 'Barat' });
      const dup = await t.http().post('/v1/event-types').set(auth).send({ name: 'Barat' });
      expect(dup.status).toBe(409);
      expect(code(dup)).toBe('DUPLICATE');
    });

    it('403: without venue.manage, and for a caller limited to some venues', async () => {
      const caller = await setupCaller(world, t);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      expect(
        (await t.http().post('/v1/event-types').set(agent.auth).send({ name: 'X' })).status,
      ).toBe(403);
      const venue = await makeVenue(t, caller.auth);
      const scoped = await scopedManagerAuth(world, t, caller.tenant, [venue.id]);
      expect((await t.http().post('/v1/event-types').set(scoped).send({ name: 'X' })).status).toBe(
        403,
      );
      // Reading is allowed for the limited manager.
      expect((await t.http().get('/v1/event-types').set(scoped)).status).toBe(200);
    });
  });

  describe('GET', () => {
    it('200: lists the tenant only; inactive on request; single; 404 other tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const walima = await makeEventType(t, a.auth, { name: 'Walima' });
      const old = await makeEventType(t, a.auth, { name: 'Old' });
      await makeEventType(t, b.auth, { name: 'Theirs' });
      await t.http().patch(`/v1/event-types/${old.id}`).set(a.auth).send({ rev: 1, active: false });

      const list = await t.http().get('/v1/event-types').set(a.auth);
      expect(list.body.data.map((e: { name: string }) => e.name)).toEqual(['Walima']);
      const all = await t.http().get('/v1/event-types?includeInactive=true').set(a.auth);
      expect(all.body.data).toHaveLength(2);
      expect((await t.http().get(`/v1/event-types/${walima.id}`).set(a.auth)).status).toBe(200);
      expect((await t.http().get(`/v1/event-types/${walima.id}`).set(b.auth)).status).toBe(404);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      expect((await t.http().get('/v1/event-types').set(agent.auth)).status).toBe(403);
    });
  });

  describe('PATCH /v1/event-types/:id', () => {
    it('200: renames, recolours, soft-deletes; audits', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const type = await makeEventType(t, auth, { name: 'Dholki' });
      const res = await t
        .http()
        .patch(`/v1/event-types/${type.id}`)
        .set(auth)
        .send({ rev: type.rev, name: 'Dholki night', color: null, active: false });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Dholki night', color: null, active: false, rev: 2 });
      expect(
        await world.auditRows(tenant, { action: 'event_type.update', entityId: type.id }),
      ).toHaveLength(1);
    });

    it('409: stale rev and a name that is taken; 400: nothing to change', async () => {
      const { auth } = await setupCaller(world, t);
      const one = await makeEventType(t, auth, { name: 'One' });
      await makeEventType(t, auth, { name: 'Two' });
      const path = `/v1/event-types/${one.id}`;
      expect((await t.http().patch(path).set(auth).send({ rev: 1, name: 'Two' })).status).toBe(409);
      await t.http().patch(path).set(auth).send({ rev: 1, name: 'Uno' });
      const stale = await t.http().patch(path).set(auth).send({ rev: 1, name: 'Eins' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect((await t.http().patch(path).set(auth).send({ rev: 2 })).status).toBe(400);
    });

    it('403 without permission; 404 for another tenant', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const type = await makeEventType(t, a.auth);
      const agent = await setupCaller(world, t, { role: { role: 'sales_agent' } });
      const path = `/v1/event-types/${type.id}`;
      expect((await t.http().patch(path).set(agent.auth).send({ rev: 1, name: 'X' })).status).toBe(
        403,
      );
      expect((await t.http().patch(path).set(b.auth).send({ rev: 1, name: 'X' })).status).toBe(404);
    });
  });
});
