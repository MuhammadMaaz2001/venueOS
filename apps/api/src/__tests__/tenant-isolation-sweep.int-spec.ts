import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthHarness, TEST_ENV, uniqueEmail } from './helpers/auth-harness';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { scanRoutes } from './helpers/route-scan';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// PHASE 0 EXIT GATE (docs/09): "a staff user invited into tenant A cannot see anything of tenant B through any
// endpoint". Per-endpoint tests already cover the other-tenant 404; this sweep proves it for EVERY route of the
// application at once and, above all, makes the list impossible to forget: a new tenant route that has no entry in
// ISOLATION_CASES (or in NOT_TENANT_DATA with a reason) fails the coverage test below.
//
// Two people of tenant A act against tenant B's real ids: the Owner (holds every permission, so only the tenant
// check stands between them and B's data) and a Sales agent (a staff member without staff or role rights).

interface Victim {
  tenant: TestTenant;
  roleId: string;
  membershipId: string;
  userId: string;
  email: string;
  invitationId: string;
  inviteeEmail: string;
  inviteToken: string;
  /** Module 1 records of tenant B. */
  venueId: string;
  spaceId: string;
  slotId: string;
  eventTypeId: string;
  /** Module 2: one audit row of tenant B. */
  auditLogId: string;
  /** Module 3: B's catalogue and pricing records. */
  menuItemId: string;
  packageId: string;
  addOnId: string;
  customFieldId: string;
  priceRuleId: string;
  taxRateId: string;
  policyId: string;
}

interface IsolationCase {
  /** What the Owner of tenant A gets when the request names tenant B's data. */
  owner: number | readonly number[];
  request: (v: Victim) => {
    method: 'get' | 'post' | 'patch' | 'put' | 'delete';
    path: string;
    body?: object;
  };
}

/** `Controller.handler` -> the attack. Every tenant-scoped route of the application must be here. */
const ISOLATION_CASES: Record<string, IsolationCase> = {
  'RolesController.list': { owner: 200, request: () => ({ method: 'get', path: '/v1/roles' }) },
  'RolesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/roles/${v.roleId}` }),
  },
  'RolesController.create': {
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/roles',
      body: { name: 'Copy of B', copyFromRoleId: v.roleId },
    }),
  },
  'RolesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/roles/${v.roleId}`,
      // Retiring is the same route: B's role must stay active.
      body: { rev: 1, name: 'Hijacked', active: false },
    }),
  },
  'StaffController.list': {
    owner: 200,
    // The active tenant comes from the session: a tenantId in the query changes nothing.
    request: (v) => ({ method: 'get', path: `/v1/staff?tenantId=${v.tenant.id}` }),
  },
  'StaffController.assignableRoles': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/staff/assignable-roles' }),
  },
  'StaffController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/staff/${v.membershipId}`,
      body: { rev: 1, active: false },
    }),
  },
  'InvitationsController.create': {
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/staff/invitations',
      body: { email: uniqueEmail('sweep'), roleId: v.roleId },
    }),
  },
  'InvitationsController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/staff/invitations' }),
  },
  'InvitationsController.revoke': {
    owner: 404,
    request: (v) => ({ method: 'delete', path: `/v1/staff/invitations/${v.invitationId}` }),
  },
  'MeController.tenants': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/me/tenants' }),
  },
  'MeController.switchTenant': {
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/me/switch-tenant',
      body: { tenantId: v.tenant.id },
    }),
  },
  'MeController.accept': {
    // B's invitation is addressed to someone else: it answers like an invalid one, and stays usable by them.
    owner: 400,
    request: (v) => ({
      method: 'post',
      path: '/v1/me/invitations/accept',
      body: { token: v.inviteToken },
    }),
  },
  // ── module 2: audit log ───────────────────────────────────────────────────────────────────────────────
  'AuditLogsController.list': {
    // A tenantId / entityId of B in the query only filters A's own rows: nothing of B comes back.
    owner: 200,
    request: (v) => ({
      method: 'get',
      path: `/v1/audit-logs?tenantId=${v.tenant.id}&entityId=${v.venueId}&limit=100`,
    }),
  },
  'AuditLogsController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/audit-logs/${v.auditLogId}` }),
  },
  // ── module 1: setup (venues, spaces, slots, prices, event types, settings) ──────────────────────────────
  'TenantSettingsController.get': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/tenant/settings' }),
  },
  'TenantSettingsController.update': {
    // Changes the caller's OWN workspace; a tenantId in the body is ignored.
    owner: 200,
    request: (v) => ({
      method: 'patch',
      path: '/v1/tenant/settings',
      body: { rev: 1, name: 'Sweep workspace', tenantId: v.tenant.id },
    }),
  },
  'VenuesController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/venues?includeInactive=true' }),
  },
  'VenuesController.create': {
    // Lands in A (the tenant comes from the session): checked in the database afterwards.
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/venues',
      body: { name: 'Sweep venue', tenantId: v.tenant.id },
    }),
  },
  'VenuesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/venues/${v.venueId}` }),
  },
  'VenuesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/venues/${v.venueId}`,
      body: { rev: 1, name: 'Hijacked' },
    }),
  },
  'SpacesController.list': {
    // Asking for B's venue only narrows: nothing of B comes back.
    owner: 200,
    request: (v) => ({
      method: 'get',
      path: `/v1/spaces?venueId=${v.venueId}&includeInactive=true`,
    }),
  },
  'SpacesController.create': {
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/spaces',
      body: { venueId: v.venueId, name: 'Hijack space' },
    }),
  },
  'SpacesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/spaces/${v.spaceId}` }),
  },
  'SpacesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/spaces/${v.spaceId}`,
      body: { rev: 1, name: 'Hijacked' },
    }),
  },
  'SpacesController.slotPrices': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/spaces/${v.spaceId}/slot-prices` }),
  },
  'SpacesController.replaceSlotPrices': {
    owner: 404,
    request: (v) => ({
      method: 'put',
      path: `/v1/spaces/${v.spaceId}/slot-prices`,
      body: { prices: [{ slotId: v.slotId, rent: '1' }] },
    }),
  },
  'SlotTemplatesController.list': {
    owner: 200,
    request: (v) => ({
      method: 'get',
      path: `/v1/slot-templates?venueId=${v.venueId}&includeInactive=true`,
    }),
  },
  'SlotTemplatesController.create': {
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/slot-templates',
      body: { venueId: v.venueId, name: 'Hijack slot', mode: 'FULL_DAY' },
    }),
  },
  'SlotTemplatesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/slot-templates/${v.slotId}` }),
  },
  'SlotTemplatesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/slot-templates/${v.slotId}`,
      body: { rev: 1, name: 'Hijacked' },
    }),
  },
  'EventTypesController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/event-types?includeInactive=true' }),
  },
  'EventTypesController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/event-types',
      body: { name: 'Sweep event', tenantId: v.tenant.id },
    }),
  },
  'EventTypesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/event-types/${v.eventTypeId}` }),
  },
  'EventTypesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/event-types/${v.eventTypeId}`,
      body: { rev: 1, name: 'Hijacked' },
    }),
  },
  // ── module 3: catalogue and pricing ─────────────────────────────────────────────────────────────────────
  'MenuItemsController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/menu-items?includeInactive=true' }),
  },
  'MenuItemsController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/menu-items',
      body: { name: 'Sweep dish', tenantId: v.tenant.id },
    }),
  },
  'MenuItemsController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/menu-items/${v.menuItemId}` }),
  },
  'MenuItemsController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/menu-items/${v.menuItemId}`,
      body: { rev: 1, name: 'Hijacked', active: false },
    }),
  },
  'PackagesController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/packages?includeInactive=true' }),
  },
  'PackagesController.create': {
    // B's dish in A's package: the dish does not exist for A.
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/packages',
      body: { name: 'Hijack package', perHeadRate: '1', items: [{ menuItemId: v.menuItemId }] },
    }),
  },
  'PackagesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/packages/${v.packageId}` }),
  },
  'PackagesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/packages/${v.packageId}`,
      body: { rev: 1, name: 'Hijacked', items: [] },
    }),
  },
  'AddOnsController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/add-ons?includeInactive=true' }),
  },
  'AddOnsController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/add-ons',
      body: { name: 'Sweep add-on', pricing: 'FIXED', price: '1', tenantId: v.tenant.id },
    }),
  },
  'AddOnsController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/add-ons/${v.addOnId}` }),
  },
  'AddOnsController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/add-ons/${v.addOnId}`,
      body: { rev: 1, name: 'Hijacked', price: '1' },
    }),
  },
  'CustomFieldsController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/custom-fields?includeInactive=true' }),
  },
  'CustomFieldsController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/custom-fields',
      body: {
        entity: 'customer',
        key: 'sweep_field',
        label: 'Sweep field',
        type: 'text',
        tenantId: v.tenant.id,
      },
    }),
  },
  'CustomFieldsController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/custom-fields/${v.customFieldId}` }),
  },
  'CustomFieldsController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/custom-fields/${v.customFieldId}`,
      body: { rev: 1, label: 'Hijacked' },
    }),
  },
  'PriceRulesController.list': {
    // B's space in the query only filters A's own rules.
    owner: 200,
    request: (v) => ({
      method: 'get',
      path: `/v1/price-rules?includeInactive=true&spaceId=${v.spaceId}`,
    }),
  },
  'PriceRulesController.create': {
    // A rule for B's space does not exist for A.
    owner: 404,
    request: (v) => ({
      method: 'post',
      path: '/v1/price-rules',
      body: {
        name: 'Hijack rule',
        kind: 'DAY_OF_WEEK',
        daysOfWeek: [6],
        adjustment: 'PERCENT',
        value: '10',
        spaceId: v.spaceId,
      },
    }),
  },
  'PriceRulesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/price-rules/${v.priceRuleId}` }),
  },
  'PriceRulesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/price-rules/${v.priceRuleId}`,
      body: { rev: 1, name: 'Hijacked', active: false },
    }),
  },
  'PriceRulesController.rentPreview': {
    owner: 404,
    request: (v) => ({
      method: 'get',
      path: `/v1/pricing/rent-preview?venueId=${v.venueId}&spaceId=${v.spaceId}&slotId=${v.slotId}&date=2027-01-02`,
    }),
  },
  'TaxRatesController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/tax-rates?includeInactive=true' }),
  },
  'TaxRatesController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/tax-rates',
      body: { name: 'Sweep tax', ratePct: '1', isDefault: true, tenantId: v.tenant.id },
    }),
  },
  'TaxRatesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/tax-rates/${v.taxRateId}` }),
  },
  'TaxRatesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/tax-rates/${v.taxRateId}`,
      body: { rev: 1, name: 'Hijacked', isDefault: false },
    }),
  },
  'CancellationPoliciesController.list': {
    owner: 200,
    request: () => ({ method: 'get', path: '/v1/cancellation-policies?includeInactive=true' }),
  },
  'CancellationPoliciesController.create': {
    owner: 201,
    request: (v) => ({
      method: 'post',
      path: '/v1/cancellation-policies',
      body: {
        name: 'Sweep policy',
        tiers: [{ minDaysBefore: 0, refundPct: 0 }],
        isDefault: true,
        tenantId: v.tenant.id,
      },
    }),
  },
  'CancellationPoliciesController.get': {
    owner: 404,
    request: (v) => ({ method: 'get', path: `/v1/cancellation-policies/${v.policyId}` }),
  },
  'CancellationPoliciesController.update': {
    owner: 404,
    request: (v) => ({
      method: 'patch',
      path: `/v1/cancellation-policies/${v.policyId}`,
      body: { rev: 1, name: 'Hijacked', isDefault: false },
    }),
  },
};

/** Routes that are not tenant data, with the reason. */
const NOT_TENANT_DATA: Record<string, string> = {
  'MeController.get': 'my own identity and the permissions of MY active workspace',
  'AuthController.logout': 'ends my own session',
  'AuthController.logoutAll': 'ends my own sessions',
  'AuthController.changePassword': 'my own credentials',
};

describe('tenant isolation sweep (Phase 0 exit gate)', () => {
  let t: TestApp;
  let h: AuthHarness;
  let world: World;
  let victim: Victim;
  let ownerHeaders: Record<string, string>;
  let agentHeaders: Record<string, string>;
  /** Everything of tenant B that must never appear in an answer to tenant A. */
  let secrets: string[];

  beforeAll(async () => {
    // No test controllers: only what the production AppModule registers (the coverage test below counts them).
    t = await createTestApp({ env: TEST_ENV, realAuth: true, controllers: [] });
    h = new AuthHarness();
    world = new World();

    // Tenant A: an Owner and a Sales agent (a staff member without staff / role rights).
    const tenantA = await world.createTenant({ plan: 'growth' });
    const ownerA = await h.member(world, tenantA, { role: 'owner' });
    const agentA = await h.member(world, tenantA, { role: 'sales_agent' });
    ownerHeaders = await h.sessionHeaders(t, ownerA.email);
    agentHeaders = await h.sessionHeaders(t, agentA.email);

    // Tenant B: an owner, a staff member, a custom role and a pending invitation.
    const tenantB = await world.createTenant({ plan: 'growth' });
    const ownerB = await h.member(world, tenantB, { role: 'owner' });
    const staffB = await h.member(world, tenantB, { role: 'accountant' });
    const customRole = await world.addMember(tenantB, {
      role: { name: 'B secret role', permissions: ['customer.view'] },
    });
    const inviteeEmail = uniqueEmail('b-invitee');
    const ownerBHeaders = await h.sessionHeaders(t, ownerB.email);
    const invited = await t
      .http()
      .post('/v1/staff/invitations')
      .set(ownerBHeaders)
      .send({ email: inviteeEmail, roleId: tenantB.roles.accountant });
    expect(invited.status).toBe(201);
    const mail = await h.lastMail(inviteeEmail, 'staff.invite');

    // Tenant B's setup records, created through the API like a real user would.
    const post = async (path: string, body: object) => {
      const res = await t.http().post(path).set(ownerBHeaders).send(body);
      expect(res.status, path).toBe(201);
      return res.body as { id: string };
    };
    const venueB = await post('/v1/venues', { name: 'B secret venue' });
    const spaceB = await post('/v1/spaces', { venueId: venueB.id, name: 'B secret space' });
    const slotB = await post('/v1/slot-templates', {
      venueId: venueB.id,
      name: 'B secret slot',
      mode: 'FIXED',
      startTime: '12:00',
      endTime: '16:00',
    });
    const eventB = await post('/v1/event-types', { name: 'B secret event' });
    // Module 3: B's catalogue and pricing records.
    const menuItemB = await post('/v1/menu-items', { name: 'B secret dish', category: 'Main' });
    const packageB = await post('/v1/packages', {
      name: 'B secret package',
      perHeadRate: '1234.50',
      items: [{ menuItemId: menuItemB.id }],
    });
    const addOnB = await post('/v1/add-ons', {
      name: 'B secret add-on',
      pricing: 'FIXED',
      price: '777',
    });
    const fieldB = await post('/v1/custom-fields', {
      entity: 'customer',
      key: 'b_secret_field',
      label: 'B secret field',
      type: 'text',
    });
    const ruleB = await post('/v1/price-rules', {
      name: 'B secret rule',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [5],
      adjustment: 'PERCENT',
      value: '33',
      spaceId: spaceB.id,
    });
    const taxB = await post('/v1/tax-rates', {
      name: 'B secret tax',
      ratePct: '9',
      isDefault: true,
    });
    const policyB = await post('/v1/cancellation-policies', {
      name: 'B secret policy',
      tiers: [{ minDaysBefore: 0, refundPct: 0 }],
      isDefault: true,
    });

    victim = {
      tenant: tenantB,
      roleId: customRole.roleId,
      membershipId: staffB.membershipId,
      userId: staffB.userId,
      email: staffB.email,
      invitationId: invited.body.id,
      inviteeEmail,
      inviteToken: String(mail.token),
      venueId: venueB.id,
      spaceId: spaceB.id,
      slotId: slotB.id,
      eventTypeId: eventB.id,
      menuItemId: menuItemB.id,
      packageId: packageB.id,
      addOnId: addOnB.id,
      customFieldId: fieldB.id,
      priceRuleId: ruleB.id,
      taxRateId: taxB.id,
      policyId: policyB.id,
      auditLogId: (
        await h.sql<{ id: string }>(
          `SELECT id FROM audit_logs WHERE tenant_id = $1 AND action = 'venue.create'`,
          [tenantB.id],
        )
      )[0]?.id as string,
    };
    secrets = [
      tenantB.id,
      ...Object.values(tenantB.roles),
      customRole.roleId,
      'B secret role',
      ownerB.userId,
      ownerB.email,
      ownerB.membershipId,
      staffB.userId,
      staffB.email,
      staffB.membershipId,
      invited.body.id,
      inviteeEmail,
      tenantB.id.replace(/_/g, '-'), // its slug
      `Test ${tenantB.id}`, // its name
      venueB.id,
      spaceB.id,
      slotB.id,
      eventB.id,
      victim.auditLogId,
      'B secret venue',
      'B secret space',
      'B secret slot',
      'B secret event',
      menuItemB.id,
      packageB.id,
      addOnB.id,
      fieldB.id,
      ruleB.id,
      taxB.id,
      policyB.id,
      'B secret dish',
      'B secret package',
      'B secret add-on',
      'b_secret_field',
      'B secret field',
      'B secret rule',
      'B secret tax',
      'B secret policy',
      '1234.50',
    ];
    // Explicit and generous: this world needs ~10 argon2 logins plus dozens of API calls, which took longer than
    // the 10 s default when the whole suite ran in parallel.
  }, 120_000);

  afterAll(async () => {
    await t.app.close();
    await h.close();
    await world.close();
  });

  it('every route that is not public has an isolation case or a reason why it holds no tenant data', () => {
    const routes = scanRoutes(t.app.get(ModulesContainer)).filter((r) => !r.isPublic);
    const missing = routes
      .map((r) => `${r.controller}.${r.handler}`)
      .filter((name) => !(name in ISOLATION_CASES) && !(name in NOT_TENANT_DATA));
    expect(missing, 'add an entry to ISOLATION_CASES for each new tenant route').toEqual([]);
    // No stale entries either.
    const known = new Set(routes.map((r) => `${r.controller}.${r.handler}`));
    const stale = [...Object.keys(ISOLATION_CASES), ...Object.keys(NOT_TENANT_DATA)].filter(
      (name) => !known.has(name),
    );
    expect(stale).toEqual([]);
  });

  describe.each(Object.entries(ISOLATION_CASES))('%s', (name, c) => {
    const send = (headers: Record<string, string>) => {
      const { method, path, body } = c.request(victim);
      const req = t.http()[method](path).set(headers);
      return body ? req.send(body) : req;
    };

    it("the Owner of tenant A never gets tenant B's data", async () => {
      const res = await send(ownerHeaders);
      expect(res.status, name).toBe(c.owner);
      const text = JSON.stringify(res.body);
      for (const secret of secrets) expect(text, `${name} leaked ${secret}`).not.toContain(secret);
    });

    it('a Sales agent of tenant A gets nothing either (403 where a permission is needed)', async () => {
      const res = await send(agentHeaders);
      expect([200, 400, 403, 404]).toContain(res.status);
      const text = JSON.stringify(res.body);
      for (const secret of secrets) expect(text, `${name} leaked ${secret}`).not.toContain(secret);
    });
  });

  it('tenant B is untouched after every attack: members, roles and invitations unchanged', async () => {
    const [membership] = await h.sql<{ active: boolean; rev: number }>(
      `SELECT active, rev FROM memberships WHERE id = $1`,
      [victim.membershipId],
    );
    expect(membership).toEqual({ active: true, rev: 1 });
    const [role] = await h.sql<{ name: string; rev: number }>(
      `SELECT name, rev FROM roles WHERE id = $1`,
      [victim.roleId],
    );
    expect(role).toEqual({ name: 'B secret role', rev: 1 });
    const [roleActive] = await h.sql<{ active: boolean }>(
      `SELECT active FROM roles WHERE id = $1`,
      [victim.roleId],
    );
    expect(roleActive).toEqual({ active: true });
    const [invitation] = await h.sql<{ revoked_at: Date | null; accepted_at: Date | null }>(
      `SELECT revoked_at, accepted_at FROM invitations WHERE id = $1`,
      [victim.invitationId],
    );
    expect(invitation).toEqual({ revoked_at: null, accepted_at: null });
    // And no role was created in B by the copy attempt, nor in A out of B's role.
    const copies = await h.sql<{ id: string }>(`SELECT id FROM roles WHERE name = 'Copy of B'`);
    expect(copies).toEqual([]);

    // Module 1: B's workspace, venue, space, slot and event type are as created.
    const [tenant] = await h.sql<{ name: string; rev: number }>(
      `SELECT name, rev FROM tenants WHERE id = $1`,
      [victim.tenant.id],
    );
    expect(tenant).toEqual({ name: `Test ${victim.tenant.id}`, rev: 1 });
    for (const [table, id, name] of [
      ['venues', victim.venueId, 'B secret venue'],
      ['spaces', victim.spaceId, 'B secret space'],
      ['slot_templates', victim.slotId, 'B secret slot'],
      ['event_types', victim.eventTypeId, 'B secret event'],
      ['menu_items', victim.menuItemId, 'B secret dish'],
      ['packages', victim.packageId, 'B secret package'],
      ['add_ons', victim.addOnId, 'B secret add-on'],
      ['price_rules', victim.priceRuleId, 'B secret rule'],
      ['tax_rates', victim.taxRateId, 'B secret tax'],
      ['cancellation_policies', victim.policyId, 'B secret policy'],
    ] as const) {
      const [row] = await h.sql<{ name: string; rev: number }>(
        `SELECT name, rev FROM ${table} WHERE id = $1`,
        [id],
      );
      expect(row, table).toEqual({ name, rev: 1 });
    }
    // Nothing the attacks created landed in B, and no slot price was written for B's space.
    for (const table of [
      'venues',
      'event_types',
      'spaces',
      'slot_templates',
      'menu_items',
      'packages',
      'add_ons',
      'price_rules',
      'tax_rates',
      'cancellation_policies',
    ]) {
      const strays = await h.sql<{ id: string }>(
        `SELECT id FROM ${table} WHERE tenant_id = $1 AND (name LIKE 'Sweep%' OR name LIKE 'Hijack%')`,
        [victim.tenant.id],
      );
      expect(strays, table).toEqual([]);
    }
    const prices = await h.sql<{ rent: string }>(
      `SELECT rent FROM space_slot_prices WHERE space_id = $1`,
      [victim.spaceId],
    );
    expect(prices).toEqual([]);

    // Module 3: B's package still has its one dish; B's default tax rate and policy are still its defaults (the
    // attacks that "set a default" landed in A); its custom field and price rule are untouched.
    const items = await h.sql<{ menu_item_id: string }>(
      `SELECT menu_item_id FROM package_items WHERE package_id = $1`,
      [victim.packageId],
    );
    expect(items).toEqual([{ menu_item_id: victim.menuItemId }]);
    for (const table of ['tax_rates', 'cancellation_policies']) {
      const defaults = await h.sql<{ id: string }>(
        `SELECT id FROM ${table} WHERE tenant_id = $1 AND is_default AND active`,
        [victim.tenant.id],
      );
      expect(defaults, table).toHaveLength(1);
    }
    const [field] = await h.sql<{ label: string; rev: number }>(
      `SELECT label, rev FROM custom_field_defs WHERE id = $1`,
      [victim.customFieldId],
    );
    expect(field).toEqual({ label: 'B secret field', rev: 1 });
    const [rule] = await h.sql<{ active: boolean }>(
      `SELECT active FROM price_rules WHERE id = $1`,
      [victim.priceRuleId],
    );
    expect(rule).toEqual({ active: true });
  });

  it("the workspace list of tenant A's owner holds tenant A only", async () => {
    const res = await t.http().get('/v1/me/tenants').set(ownerHeaders);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).not.toBe(victim.tenant.id);
  });
});
