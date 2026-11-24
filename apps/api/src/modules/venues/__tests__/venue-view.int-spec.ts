import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  makeEventType,
  makeSlot,
  makeSpace,
  makeVenue,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';

// `venue.view` reads venues, spaces, slot templates and event types; `venue.manage` writes them (docs/04 section 2).

describe('venue.view', () => {
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

  it('every default role can read the setup', () => {
    for (const role of DEFAULT_ROLES) expect(role.permissions, role.name).toContain('venue.view');
  });

  it('a read-only role reads everything but cannot write, and sees no rent unless it may see prices', async () => {
    const owner = await setupCaller(world, t);
    const venue = await makeVenue(t, owner.auth);
    const space = await makeSpace(t, owner.auth, venue.id, { baseRent: '90000' });
    const slot = await makeSlot(t, owner.auth, venue.id);
    await makeEventType(t, owner.auth);

    // Operations: venue.view only (no booking.view_prices).
    const ops = await world.addMember(owner.tenant, { role: 'operations' });
    const opsAuth = t.as(authHeader(ops.userId, owner.tenant.id));
    for (const path of [
      '/v1/venues',
      `/v1/venues/${venue.id}`,
      `/v1/spaces?venueId=${venue.id}`,
      `/v1/spaces/${space.id}`,
      `/v1/slot-templates?venueId=${venue.id}`,
      `/v1/slot-templates/${slot.id}`,
      '/v1/event-types',
    ]) {
      expect((await t.http().get(path).set(opsAuth)).status, path).toBe(200);
    }
    const seen = await t.http().get(`/v1/spaces/${space.id}`).set(opsAuth);
    expect(seen.body.name).toBe('Hall A');
    expect(seen.body.baseRent).toBeNull();
    const list = await t.http().get(`/v1/spaces?venueId=${venue.id}`).set(opsAuth);
    expect(list.body.data[0].baseRent).toBeNull();

    // The per-slot rent list is a manager's view.
    expect((await t.http().get(`/v1/spaces/${space.id}/slot-prices`).set(opsAuth)).status).toBe(
      403,
    );

    // No write.
    const writes = [
      t.http().post('/v1/venues').send({ name: 'X' }),
      t.http().patch(`/v1/venues/${venue.id}`).send({ rev: 1, name: 'X' }),
      t.http().post('/v1/spaces').send({ venueId: venue.id, name: 'X' }),
      t.http().patch(`/v1/spaces/${space.id}`).send({ rev: 1, name: 'X' }),
      t.http().put(`/v1/spaces/${space.id}/slot-prices`).send({ prices: [] }),
      t.http().post('/v1/slot-templates').send({ venueId: venue.id, name: 'X', mode: 'FULL_DAY' }),
      t.http().patch(`/v1/slot-templates/${slot.id}`).send({ rev: 1, name: 'X' }),
      t.http().post('/v1/event-types').send({ name: 'X' }),
    ];
    for (const req of writes) expect((await req.set(opsAuth)).status).toBe(403);

    // A Sales agent has booking.view_prices: the default rent is visible to them.
    const agent = await world.addMember(owner.tenant, { role: 'sales_agent' });
    const agentAuth = t.as(authHeader(agent.userId, owner.tenant.id));
    const agentSees = await t.http().get(`/v1/spaces/${space.id}`).set(agentAuth);
    expect(agentSees.body.baseRent).toBe('90000.00');
  });

  it('venue.view alone does not widen the venue scope: a limited caller still gets 404 outside their venues', async () => {
    const owner = await setupCaller(world, t);
    const mine = await makeVenue(t, owner.auth, { name: 'Mine' });
    const other = await makeVenue(t, owner.auth, { name: 'Other' });
    const member = await world.addMember(owner.tenant, {
      role: 'sales_agent',
      venueIds: [mine.id],
    });
    const auth = t.as(authHeader(member.userId, owner.tenant.id));
    const list = await t.http().get('/v1/venues').set(auth);
    expect(list.body.data.map((v: { id: string }) => v.id)).toEqual([mine.id]);
    expect((await t.http().get(`/v1/venues/${other.id}`).set(auth)).status).toBe(404);
  });
});
