import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { scanRoutes } from './helpers/route-scan';
import {
  makeEventType,
  makeSlot,
  makeSpace,
  makeVenue,
  setupCaller,
} from './helpers/setup-fixtures';
import type { Caller } from './helpers/setup-fixtures';
import { World } from './helpers/world';

// Tenant isolation sweep (docs/04-security.md section 3, docs/09 P0 exit gate): tenant A, a full Owner on an
// enterprise plan (so permissions and plan limits are never the reason for an answer), calls every route that
// takes an id with the ids of tenant B. Each must answer 404 (never 403, never data) and leave B untouched.
//
// EVERY NEW ROUTE THAT TAKES AN ID goes into PROBES below (the coverage test fails otherwise).

interface TheirIds {
  venueId: string;
  spaceId: string;
  spaceBId: string;
  slotId: string;
  eventTypeId: string;
  roleId: string;
  membershipId: string;
}

interface Probe {
  method: 'get' | 'patch' | 'put' | 'post';
  path: (b: TheirIds) => string;
  body?: (b: TheirIds) => Record<string, unknown>;
}

/** Keyed `Controller.handler`, as the route scan names them. */
const PROBES: Record<string, Probe[]> = {
  'VenuesController.get': [{ method: 'get', path: (b) => `/v1/venues/${b.venueId}` }],
  'VenuesController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/venues/${b.venueId}`,
      body: () => ({ rev: 1, name: 'Hijacked' }),
    },
  ],
  'SpacesController.get': [{ method: 'get', path: (b) => `/v1/spaces/${b.spaceId}` }],
  'SpacesController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/spaces/${b.spaceId}`,
      body: () => ({ rev: 1, name: 'Hijacked' }),
    },
  ],
  'SpacesController.slotPrices': [
    { method: 'get', path: (b) => `/v1/spaces/${b.spaceId}/slot-prices` },
  ],
  'SpacesController.replaceSlotPrices': [
    {
      method: 'put',
      path: (b) => `/v1/spaces/${b.spaceId}/slot-prices`,
      body: () => ({ prices: [] }),
    },
  ],
  'SlotTemplatesController.get': [{ method: 'get', path: (b) => `/v1/slot-templates/${b.slotId}` }],
  'SlotTemplatesController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/slot-templates/${b.slotId}`,
      body: () => ({ rev: 1, name: 'Hijacked' }),
    },
  ],
  'EventTypesController.get': [{ method: 'get', path: (b) => `/v1/event-types/${b.eventTypeId}` }],
  'EventTypesController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/event-types/${b.eventTypeId}`,
      body: () => ({ rev: 1, name: 'Hijacked' }),
    },
  ],
  'RolesController.get': [{ method: 'get', path: (b) => `/v1/roles/${b.roleId}` }],
  'RolesController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/roles/${b.roleId}`,
      body: () => ({ rev: 1, limits: { maxDiscountPct: 1 } }),
    },
  ],
  'StaffController.update': [
    {
      method: 'patch',
      path: (b) => `/v1/staff/${b.membershipId}`,
      body: () => ({ rev: 1, active: false }),
    },
  ],
};

/** Routes that create something from ids in the BODY: another tenant's id must be a 404 there too. */
const BODY_PROBES: { name: string; probe: Probe }[] = [
  {
    name: 'POST /v1/spaces with their venue',
    probe: {
      method: 'post',
      path: () => '/v1/spaces',
      body: (b) => ({ venueId: b.venueId, name: 'Hijack' }),
    },
  },
  {
    name: 'POST /v1/slot-templates with their venue',
    probe: {
      method: 'post',
      path: () => '/v1/slot-templates',
      body: (b) => ({
        venueId: b.venueId,
        name: 'Hijack',
        mode: 'FIXED',
        startTime: '12:00',
        endTime: '16:00',
      }),
    },
  },
  {
    name: 'POST /v1/roles copying their role',
    probe: {
      method: 'post',
      path: () => '/v1/roles',
      body: (b) => ({ name: 'Hijack', copyFromRoleId: b.roleId }),
    },
  },
];

/** Routes with an id that this sweep cannot drive, each with the reason and the spec that covers it. */
const EXEMPT: Record<string, string> = {
  'InvitationsController.revoke':
    'needs the real session harness for an invitation row: staff-invitations.int-spec.ts (revoke of another tenant)',
};

describe('tenant isolation sweep', () => {
  let t: TestApp;
  let world: World;
  let a: Caller;
  let b: Caller;
  let theirs: TheirIds;
  let theirNames: string[];

  beforeAll(async () => {
    world = new World();
    t = await createTestApp({ controllers: [] });
    a = await setupCaller(world, t);
    b = await setupCaller(world, t);
    const venue = await makeVenue(t, b.auth, { name: 'Isolation-B-Venue' });
    const space = await makeSpace(t, b.auth, venue.id, { name: 'Isolation-B-Space' });
    const spaceB = await makeSpace(t, b.auth, venue.id, { name: 'Isolation-B-Space-2' });
    const slot = await makeSlot(t, b.auth, venue.id, { name: 'Isolation-B-Slot' });
    const eventType = await makeEventType(t, b.auth, { name: 'Isolation-B-Event' });
    // Tenant A has its own records, so a list that leaked would show a mix.
    const mine = await makeVenue(t, a.auth, { name: 'Isolation-A-Venue' });
    await makeSpace(t, a.auth, mine.id, { name: 'Isolation-A-Space' });
    await makeSlot(t, a.auth, mine.id, { name: 'Isolation-A-Slot' });
    await makeEventType(t, a.auth, { name: 'Isolation-A-Event' });

    const ownerB = await world.addMember(b.tenant, { role: 'owner' });
    theirs = {
      venueId: venue.id,
      spaceId: space.id,
      spaceBId: spaceB.id,
      slotId: slot.id,
      eventTypeId: eventType.id,
      roleId: b.tenant.roles.sales_agent,
      membershipId: ownerB.membershipId,
    };
    theirNames = [
      'Isolation-B-Venue',
      'Isolation-B-Space',
      'Isolation-B-Slot',
      'Isolation-B-Event',
    ];
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const call = (probe: Probe, auth: Record<string, string>) => {
    const req = t.http()[probe.method](probe.path(theirs)).set(auth);
    return probe.body ? req.send(probe.body(theirs)) : req;
  };

  it('coverage: every route that takes an id is probed or exempt (add new routes to PROBES)', () => {
    const routes = scanRoutes(t.app.get(ModulesContainer));
    const needing = routes
      .filter((r) => !r.isPublic && !r.isAuthenticatedOnly && r.path.includes(':'))
      .map((r) => `${r.controller}.${r.handler}`);
    expect(needing.length).toBeGreaterThan(10);
    const missing = needing.filter((name) => !(name in PROBES) && !(name in EXEMPT));
    expect(missing, 'routes with an id that the isolation sweep does not call').toEqual([]);
    const stale = [...Object.keys(PROBES), ...Object.keys(EXEMPT)].filter(
      (name) => !needing.includes(name),
    );
    expect(stale, 'sweep entries for routes that no longer exist').toEqual([]);
  });

  for (const [name, probes] of Object.entries(PROBES)) {
    it(`${name}: another tenant's id answers 404`, async () => {
      for (const probe of probes) {
        const res = await call(probe, a.auth);
        expect(res.status, `${probe.method} ${probe.path(theirs)}`).toBe(404);
        expect(res.body.error?.code).toBe('NOT_FOUND');
        // The answer says nothing about the other tenant.
        expect(JSON.stringify(res.body)).not.toContain(theirs.venueId);
      }
    });
  }

  for (const { name, probe } of BODY_PROBES) {
    it(`${name}: 404`, async () => {
      const res = await call(probe, a.auth);
      expect(res.status).toBe(404);
    });
  }

  it("a combined space or a price list cannot reference the other tenant's records", async () => {
    const venue = await makeVenue(t, a.auth, { name: 'Isolation-A-Venue-2' });
    const mine = await makeSpace(t, a.auth, venue.id, { name: 'Isolation-A-Space-2' });
    const combined = await t
      .http()
      .post('/v1/spaces')
      .set(a.auth)
      .send({
        venueId: venue.id,
        name: 'Combo',
        isCombined: true,
        componentIds: [mine.id, theirs.spaceId],
      });
    expect(combined.status).toBe(404);
    const prices = await t
      .http()
      .put(`/v1/spaces/${mine.id}/slot-prices`)
      .set(a.auth)
      .send({ prices: [{ slotId: theirs.slotId, rent: '1' }] });
    expect(prices.status).toBe(404);
  });

  it("list endpoints never contain the other tenant's records", async () => {
    const lists = [
      '/v1/venues?includeInactive=true',
      '/v1/spaces?includeInactive=true',
      `/v1/spaces?venueId=${theirs.venueId}`,
      '/v1/slot-templates?includeInactive=true',
      `/v1/slot-templates?venueId=${theirs.venueId}`,
      '/v1/event-types?includeInactive=true',
      '/v1/roles',
      '/v1/staff',
    ];
    for (const path of lists) {
      const res = await t.http().get(path).set(a.auth);
      expect(res.status, path).toBe(200);
      const text = JSON.stringify(res.body);
      for (const id of Object.values(theirs)) expect(text, path).not.toContain(id);
      for (const name of theirNames) expect(text, path).not.toContain(name);
    }
    const settingsA = await t.http().get('/v1/tenant/settings').set(a.auth);
    const settingsB = await t.http().get('/v1/tenant/settings').set(b.auth);
    expect(settingsA.body.slug).not.toBe(settingsB.body.slug);
  });

  it('the other tenant is untouched after the whole sweep', async () => {
    const venue = await t.http().get(`/v1/venues/${theirs.venueId}`).set(b.auth);
    expect(venue.body).toMatchObject({ name: 'Isolation-B-Venue', rev: 1 });
    const space = await t.http().get(`/v1/spaces/${theirs.spaceId}`).set(b.auth);
    expect(space.body).toMatchObject({ name: 'Isolation-B-Space', rev: 1 });
    const slot = await t.http().get(`/v1/slot-templates/${theirs.slotId}`).set(b.auth);
    expect(slot.body).toMatchObject({ name: 'Isolation-B-Slot', rev: 1 });
    const type = await t.http().get(`/v1/event-types/${theirs.eventTypeId}`).set(b.auth);
    expect(type.body).toMatchObject({ name: 'Isolation-B-Event', rev: 1 });
    const staff = await t.http().get('/v1/staff').set(b.auth);
    expect(staff.body.data.every((m: { active: boolean }) => m.active)).toBe(true);
    const role = await t.http().get(`/v1/roles/${theirs.roleId}`).set(b.auth);
    expect(role.body.rev).toBe(1);
  });
});
