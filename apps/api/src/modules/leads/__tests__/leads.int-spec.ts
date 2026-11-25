import {
  LeadActivityListResponseSchema,
  LeadAssigneeListResponseSchema,
  LeadFollowUpsSchema,
  LeadListResponseSchema,
  LeadSchema,
} from '@venueos/shared';
import type { LeadDto } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import {
  code,
  makeEventType,
  makeVenue,
  scopedManagerAuth,
  setupCaller,
} from '../../../__tests__/helpers/setup-fixtures';
import type { Caller } from '../../../__tests__/helpers/setup-fixtures';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';

// Module 5, leads: access matrix, venue scoping, stage rules (docs/05 section 12), assignee validation, the activity log
// and the "new lead assigned" email.

const HOUR = 3_600_000;
const inHours = (h: number): string => new Date(Date.now() + h * HOUR).toISOString();

describe('leads endpoints', () => {
  let t: TestApp;
  let world: World;
  let n = 0;

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  /** A workspace with one venue and a customer, acting as the Owner. */
  const setup = async () => {
    const c = await setupCaller(world, t);
    const venue = await makeVenue(t, c.auth);
    const customerRes = await t
      .http()
      .post('/v1/customers')
      .set(c.auth)
      .send({ name: `Customer ${++n}`, phone: `0300 ${String(2000000 + n)}` });
    expect(customerRes.status).toBe(201);
    return { c, venue, customer: customerRes.body as { id: string; name: string } };
  };
  type Fx = Awaited<ReturnType<typeof setup>>;

  const body = (fx: Fx, extra: Record<string, unknown> = {}) => ({
    venueId: fx.venue.id,
    customerId: fx.customer.id,
    source: 'phone',
    nextFollowUpAt: inHours(24),
    ...extra,
  });
  const post = (auth: Record<string, string>, payload: object) =>
    t.http().post('/v1/leads').set(auth).send(payload);
  const made = async (fx: Fx, extra: Record<string, unknown> = {}, auth = fx.c.auth) => {
    const res = await post(auth, body(fx, extra));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return LeadSchema.parse(res.body);
  };
  const patch = (auth: Record<string, string>, lead: LeadDto, change: object, rev = lead.rev) =>
    t
      .http()
      .patch(`/v1/leads/${lead.id}`)
      .set(auth)
      .send({ rev, ...change });
  const memberAuth = (m: { userId: string }, c: Caller) => t.as(authHeader(m.userId, c.tenant.id));
  const mails = (c: Caller, template: string) =>
    world.db.tx({ tenantId: c.tenant.id }, (tx) =>
      tx.messageLog.findMany({
        where: { tenantId: c.tenant.id, template },
        orderBy: { createdAt: 'asc' },
      }),
    );

  describe('POST /v1/leads', () => {
    it('201: an inquiry for an existing customer starts NEW, assigned to the caller, and is audited', async () => {
      const fx = await setup();
      const eventType = await makeEventType(t, fx.c.auth, { name: 'Walima' });
      const lead = await made(fx, {
        eventTypeId: eventType.id,
        preferredDate: '2027-02-14',
        guests: 400,
        budget: '1500000',
        notes: 'Wants the lawn',
      });
      expect(lead).toMatchObject({
        stage: 'NEW',
        venueId: fx.venue.id,
        eventTypeName: 'Walima',
        preferredDate: '2027-02-14',
        flexibleDates: false,
        guests: 400,
        budget: '1500000.00',
        source: 'phone',
        lostReason: null,
        rev: 1,
        customer: { id: fx.customer.id, name: fx.customer.name },
        assignee: { userId: fx.c.userId },
      });
      const rows = await world.auditRows(fx.c.tenant, { action: 'lead.create', entityId: lead.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.venueId).toBe(fx.venue.id);
      // The caller assigned it to themselves: no email.
      expect(await mails(fx.c, 'lead.assigned')).toHaveLength(0);
    });

    it('201: a new customer can be made inline (one transaction, two audit rows); a duplicate phone is only a warning', async () => {
      const fx = await setup();
      const res = await post(fx.c.auth, {
        venueId: fx.venue.id,
        source: 'walk_in',
        nextFollowUpAt: inHours(2),
        customer: { name: 'Inline Person', phone: '0345 1234567', email: 'inline@x.test' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const lead = LeadSchema.parse(res.body);
      expect(lead.customer).toMatchObject({ name: 'Inline Person', phone: '+923451234567' });
      expect(
        await world.auditRows(fx.c.tenant, {
          action: 'customer.create',
          entityId: lead.customer.id,
        }),
      ).toHaveLength(1);
      const again = await post(fx.c.auth, {
        venueId: fx.venue.id,
        source: 'whatsapp',
        nextFollowUpAt: inHours(2),
        customer: { name: 'Same Phone', phone: '+92 345 1234567' },
      });
      expect(again.status).toBe(201);
      expect(again.body.customer.id).not.toBe(lead.customer.id);
    });

    it('an inline customer needs customer.manage; a bad inline customer creates no lead', async () => {
      const fx = await setup();
      const leadOnly = await world.addMember(fx.c.tenant, {
        role: { permissions: ['venue.view', 'lead.view', 'lead.manage', 'customer.view'] },
      });
      const denied = await post(memberAuth(leadOnly, fx.c), {
        venueId: fx.venue.id,
        source: 'phone',
        nextFollowUpAt: inHours(2),
        customer: { name: 'No Rights', phone: '0300 1234567' },
      });
      expect(denied.status).toBe(403);
      // ... but may use an existing customer.
      expect((await post(memberAuth(leadOnly, fx.c), body(fx))).status).toBe(201);
      const bad = await post(fx.c.auth, {
        venueId: fx.venue.id,
        source: 'phone',
        nextFollowUpAt: inHours(2),
        customer: { name: 'Bad Phone', phone: 'abc' },
      });
      expect(bad.status).toBe(400);
      const list = await t.http().get('/v1/customers?search=Bad%20Phone').set(fx.c.auth);
      expect(list.body.data).toEqual([]);
    });

    it('400: no follow-up, both or neither customer, bad source, guests, budget decimals, a date that is not real', async () => {
      const fx = await setup();
      const noFollowUp: Record<string, unknown> = { ...body(fx) };
      delete noFollowUp.nextFollowUpAt;
      const noCustomer: Record<string, unknown> = { ...body(fx) };
      delete noCustomer.customerId;
      for (const payload of [
        noFollowUp,
        body(fx, { customer: { name: 'x', phone: '0300 1234567' } }),
        noCustomer,
        body(fx, { source: 'marketplace' }),
        body(fx, { guests: 0 }),
        body(fx, { guests: 100001 }),
        body(fx, { budget: '1000.123' }),
        body(fx, { budget: '-5' }),
        body(fx, { preferredDate: '2027-02-30' }),
        body(fx, { nextFollowUpAt: 'tomorrow' }),
      ]) {
        const res = await post(fx.c.auth, payload);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(code(res)).toBe('VALIDATION_ERROR');
      }
    });

    it('401 without an identity; 403 without lead.manage', async () => {
      const fx = await setup();
      expect((await t.http().post('/v1/leads').set(t.csrfHeaders).send(body(fx))).status).toBe(401);
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      const res = await post(memberAuth(accountant, fx.c), body(fx));
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it("404: another workspace's customer, venue, event type or member is never accepted", async () => {
      const fx = await setup();
      const other = await setup();
      const otherType = await makeEventType(t, other.c.auth);
      const otherMember = await world.addMember(other.c.tenant, { role: 'sales_agent' });
      for (const extra of [
        { customerId: other.customer.id },
        { venueId: other.venue.id },
        { eventTypeId: otherType.id },
        { assigneeId: otherMember.membershipId },
      ]) {
        const res = await post(fx.c.auth, body(fx, extra));
        expect(res.status, JSON.stringify(extra)).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
      }
      // Nothing was created in either workspace.
      expect((await t.http().get('/v1/leads').set(other.c.auth)).body.data).toEqual([]);
    });
  });

  describe('assignee rules', () => {
    it('must be an active member with lead.manage whose venues cover the lead’s venue', async () => {
      const fx = await setup();
      const otherVenue = await makeVenue(t, fx.c.auth, { name: 'Other Hall' });
      const noManage = await world.addMember(fx.c.tenant, { role: 'accountant' });
      const inactive = await world.addMember(fx.c.tenant, { role: 'sales_agent', active: false });
      const elsewhere = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [otherVenue.id],
      });
      for (const m of [noManage, inactive, elsewhere]) {
        const res = await post(fx.c.auth, body(fx, { assigneeId: m.membershipId }));
        expect(res.status, m.membershipId).toBe(400);
        expect(JSON.stringify(res.body.error.details)).toContain('assigneeId');
      }
      const here = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [fx.venue.id],
      });
      const everywhere = await world.addMember(fx.c.tenant, { role: 'branch_manager' });
      expect((await post(fx.c.auth, body(fx, { assigneeId: here.membershipId }))).status).toBe(201);
      expect(
        (await post(fx.c.auth, body(fx, { assigneeId: everywhere.membershipId }))).status,
      ).toBe(201);
      const nobody = await post(fx.c.auth, body(fx, { assigneeId: null }));
      expect(nobody.status).toBe(201);
      expect(nobody.body.assignee).toBeNull();
    });

    it('GET /v1/leads/assignees lists the eligible members of a venue', async () => {
      const fx = await setup();
      const otherVenue = await makeVenue(t, fx.c.auth, { name: 'Other Hall' });
      const here = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [fx.venue.id],
      });
      const elsewhere = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [otherVenue.id],
      });
      await world.addMember(fx.c.tenant, { role: 'accountant' });
      await world.addMember(fx.c.tenant, { role: 'sales_agent', active: false });
      const res = await t.http().get(`/v1/leads/assignees?venueId=${fx.venue.id}`).set(fx.c.auth);
      expect(res.status).toBe(200);
      const ids = LeadAssigneeListResponseSchema.parse(res.body).data.map((m) => m.membershipId);
      expect(ids).toContain(here.membershipId);
      expect(ids).not.toContain(elsewhere.membershipId);
      expect(ids).toHaveLength(2); // the Owner and `here`
      const all = await t.http().get('/v1/leads/assignees').set(fx.c.auth);
      expect(all.body.data.map((m: { membershipId: string }) => m.membershipId)).toContain(
        elsewhere.membershipId,
      );
      const foreign = await setup();
      expect(
        (await t.http().get(`/v1/leads/assignees?venueId=${foreign.venue.id}`).set(fx.c.auth))
          .status,
      ).toBe(404);
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      expect(
        (await t.http().get('/v1/leads/assignees').set(memberAuth(accountant, fx.c))).status,
      ).toBe(403);
    });

    it('assigning to someone else queues the “new lead assigned” email; reassigning emails the new person', async () => {
      const fx = await setup();
      const sara = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const omar = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const lead = await made(fx, { assigneeId: sara.membershipId, guests: 120 });
      const first = await mails(fx.c, 'lead.assigned');
      expect(first).toHaveLength(1);
      expect(first[0]?.to).toBe(`${sara.userId}@example.test`);
      expect(first[0]).toMatchObject({
        status: 'queued',
        event: 'lead.assigned',
        entityType: 'lead',
        entityId: lead.id,
      });
      expect(first[0]?.templateVars).toMatchObject({
        customerName: fx.customer.name,
        venueName: fx.venue.name,
        guests: '120',
        source: 'Phone',
        leadUrl: `http://localhost:3000/leads/${lead.id}`,
      });
      const moved = await patch(fx.c.auth, lead, { assigneeId: omar.membershipId });
      expect(moved.status).toBe(200);
      expect(moved.body.assignee.userId).toBe(omar.userId);
      const all = await mails(fx.c, 'lead.assigned');
      expect(all.map((m) => m.to)).toEqual([
        `${sara.userId}@example.test`,
        `${omar.userId}@example.test`,
      ]);
      // Unassigning sends nothing.
      const none = await patch(fx.c.auth, moved.body, { assigneeId: null });
      expect(none.body.assignee).toBeNull();
      expect(await mails(fx.c, 'lead.assigned')).toHaveLength(2);
    });

    it('changing the venue re-checks the current assignee', async () => {
      const fx = await setup();
      const otherVenue = await makeVenue(t, fx.c.auth, { name: 'Other Hall' });
      const sara = await world.addMember(fx.c.tenant, {
        role: 'sales_agent',
        venueIds: [fx.venue.id],
      });
      const lead = await made(fx, { assigneeId: sara.membershipId });
      const res = await patch(fx.c.auth, lead, { venueId: otherVenue.id });
      expect(res.status).toBe(400);
      const ok = await patch(fx.c.auth, lead, { venueId: otherVenue.id, assigneeId: null });
      expect(ok.status).toBe(200);
      expect(ok.body.venueId).toBe(otherVenue.id);
    });
  });

  describe('stage rules', () => {
    it('moves between open stages, both ways, and audits each move', async () => {
      const fx = await setup();
      const lead = await made(fx);
      const contacted = await patch(fx.c.auth, lead, { stage: 'CONTACTED' });
      expect(contacted.status).toBe(200);
      expect(contacted.body).toMatchObject({ stage: 'CONTACTED', rev: 2 });
      const back = await patch(fx.c.auth, contacted.body, { stage: 'NEW' });
      expect(back.body.stage).toBe('NEW');
      const rows = await world.auditRows(fx.c.tenant, {
        action: 'lead.stage_change',
        entityId: lead.id,
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ before: { stage: 'NEW' }, after: { stage: 'CONTACTED' } });
      // Staying put is not an error and not a change.
      const same = await patch(fx.c.auth, back.body, { stage: 'NEW' });
      expect(same.status).toBe(200);
      expect(same.body.rev).toBe(back.body.rev);
    });

    it('LOST needs a reason, clears the follow-up, and can be reopened with a new follow-up', async () => {
      const fx = await setup();
      const lead = await made(fx);
      const noReason = await patch(fx.c.auth, lead, { stage: 'LOST' });
      expect(noReason.status).toBe(400);
      expect(JSON.stringify(noReason.body.error.details)).toContain('lostReason');
      expect((await patch(fx.c.auth, lead, { stage: 'LOST', lostReason: '   ' })).status).toBe(400);
      const lost = await patch(fx.c.auth, lead, {
        stage: 'LOST',
        lostReason: 'Booked another hall',
      });
      expect(lost.status).toBe(200);
      expect(lost.body).toMatchObject({
        stage: 'LOST',
        lostReason: 'Booked another hall',
        nextFollowUpAt: null,
      });
      // A closed lead has no follow-up; the reason belongs to LOST only.
      expect(
        (await patch(fx.c.auth, lost.body, { notes: 'x', nextFollowUpAt: inHours(5) })).status,
      ).toBe(400);
      // LOST -> WON is refused, LOST -> open needs a follow-up.
      const toWon = await patch(fx.c.auth, lost.body, { stage: 'WON' });
      expect(toWon.status).toBe(422);
      expect(code(toWon)).toBe('INVALID_STATE_TRANSITION');
      expect((await patch(fx.c.auth, lost.body, { stage: 'CONTACTED' })).status).toBe(400);
      const reopened = await patch(fx.c.auth, lost.body, {
        stage: 'CONTACTED',
        nextFollowUpAt: inHours(48),
      });
      expect(reopened.status).toBe(200);
      expect(reopened.body).toMatchObject({ stage: 'CONTACTED', lostReason: null });
      expect(reopened.body.nextFollowUpAt).not.toBeNull();
      expect(
        (await patch(fx.c.auth, reopened.body, { notes: 'x', lostReason: 'because' })).status,
      ).toBe(400);
    });

    it('an open lead always has a follow-up; WON is final', async () => {
      const fx = await setup();
      const lead = await made(fx);
      expect((await patch(fx.c.auth, lead, { nextFollowUpAt: null })).status).toBe(400);
      const later = inHours(72);
      const moved = await patch(fx.c.auth, lead, { nextFollowUpAt: later });
      expect(moved.body.nextFollowUpAt).toBe(later);
      const won = await patch(fx.c.auth, moved.body, { stage: 'WON' });
      expect(won.status).toBe(200);
      expect(won.body).toMatchObject({ stage: 'WON', nextFollowUpAt: null });
      for (const stage of ['NEW', 'LOST', 'CONTACTED']) {
        const res = await patch(fx.c.auth, won.body, {
          stage,
          lostReason: 'x',
          nextFollowUpAt: inHours(1),
        });
        expect([400, 422], stage).toContain(res.status);
      }
      const still = await patch(fx.c.auth, won.body, { stage: 'NEW', nextFollowUpAt: inHours(1) });
      expect(still.status).toBe(422);
      expect(
        await t
          .http()
          .get(`/v1/leads/${lead.id}`)
          .set(fx.c.auth)
          .then((r) => r.body.stage),
      ).toBe('WON');
      // Notes of a won lead can still be edited.
      expect((await patch(fx.c.auth, won.body, { notes: 'Booking BK-1' })).status).toBe(200);
    });

    it('the database backs the rules up (CHECK constraints)', async () => {
      const fx = await setup();
      const lead = await made(fx);
      await expect(
        world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
          tx.lead.updateMany({ where: { id: lead.id }, data: { stage: 'LOST' } }),
        ),
      ).rejects.toThrow();
      await expect(
        world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
          tx.lead.updateMany({ where: { id: lead.id }, data: { nextFollowUpAt: null } }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('PATCH /v1/leads/:id', () => {
    it('200: edits fields, bumps rev, 409 on a stale rev, 400 on nothing / a bad value', async () => {
      const fx = await setup();
      const lead = await made(fx);
      const res = await patch(fx.c.auth, lead, {
        guests: 250,
        budget: '900000.5',
        source: 'referral',
        flexibleDates: true,
        preferredDate: '2027-03-01',
        notes: 'Second call',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        guests: 250,
        budget: '900000.50',
        source: 'referral',
        flexibleDates: true,
        preferredDate: '2027-03-01',
        notes: 'Second call',
        rev: 2,
      });
      const stale = await patch(fx.c.auth, lead, { guests: 1 });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect((await patch(fx.c.auth, res.body, {})).status).toBe(400);
      expect((await patch(fx.c.auth, res.body, { guests: 0 })).status).toBe(400);
      expect((await patch(fx.c.auth, res.body, { stage: 'FINISHED' })).status).toBe(400);
      const cleared = await patch(fx.c.auth, res.body, {
        guests: null,
        budget: null,
        preferredDate: null,
      });
      expect(cleared.body).toMatchObject({ guests: null, budget: null, preferredDate: null });
    });

    it('403 without lead.manage; another workspace’s lead is 404 and untouched', async () => {
      const fx = await setup();
      const other = await setup();
      const lead = await made(fx);
      const theirs = await made(other);
      const accountant = await world.addMember(fx.c.tenant, { role: 'accountant' });
      expect((await patch(memberAuth(accountant, fx.c), lead, { guests: 5 })).status).toBe(403);
      const attack = await patch(fx.c.auth, theirs, { guests: 5 });
      expect(attack.status).toBe(404);
      expect(
        (await t.http().get(`/v1/leads/${theirs.id}`).set(other.c.auth)).body.guests,
      ).toBeNull();
    });

    it('custom fields of the lead are validated against the lead definitions', async () => {
      const fx = await setup();
      const def = await t
        .http()
        .post('/v1/custom-fields')
        .set(fx.c.auth)
        .send({
          entity: 'lead',
          key: 'heard_from',
          label: 'Heard from',
          type: 'select',
          options: ['Facebook', 'Friend'],
        });
      expect(def.status).toBe(201);
      expect(
        (await post(fx.c.auth, body(fx, { customFields: { heard_from: 'Radio' } }))).status,
      ).toBe(400);
      const lead = await made(fx, { customFields: { heard_from: 'Friend' } });
      expect(lead.customFields).toEqual({ heard_from: 'Friend' });
      const edited = await patch(fx.c.auth, lead, { customFields: { heard_from: 'Facebook' } });
      expect(edited.body.customFields).toEqual({ heard_from: 'Facebook' });
      expect((await patch(fx.c.auth, edited.body, { customFields: { unknown: 'x' } })).status).toBe(
        400,
      );
    });
  });

  describe('venue scoping', () => {
    it('a caller limited to one venue sees and edits only its leads; the others are 404', async () => {
      const fx = await setup();
      const v2 = await makeVenue(t, fx.c.auth, { name: 'Second Hall' });
      const scoped = await scopedManagerAuth(world, t, fx.c.tenant, [fx.venue.id]);
      const mine = await made(fx);
      const theirs = await made(fx, { venueId: v2.id });

      const list = await t.http().get('/v1/leads').set(scoped);
      expect(list.body.data.map((l: LeadDto) => l.id)).toEqual([mine.id]);
      const asked = await t.http().get(`/v1/leads?venueId=${v2.id}`).set(scoped);
      expect(asked.body.data).toEqual([]);
      expect((await t.http().get(`/v1/leads/${theirs.id}`).set(scoped)).status).toBe(404);
      expect((await t.http().get(`/v1/leads/${theirs.id}/activity`).set(scoped)).status).toBe(404);
      expect((await patch(scoped, theirs, { notes: 'x' })).status).toBe(404);
      expect((await post(scoped, body(fx, { venueId: v2.id }))).status).toBe(404);
      expect((await t.http().get('/v1/leads?followUp=overdue').set(scoped)).status).toBe(200);
      // Moving a lead of mine into a venue I cannot see is refused too.
      expect((await patch(scoped, mine, { venueId: v2.id })).status).toBe(404);
      expect((await t.http().get(`/v1/leads/${mine.id}`).set(scoped)).status).toBe(200);
      // The customer page lists only the leads of the caller's venues.
      const customer = await t.http().get(`/v1/customers/${fx.customer.id}`).set(scoped);
      expect(customer.body.leads.map((l: { id: string }) => l.id)).toEqual([mine.id]);
      const full = await t.http().get(`/v1/customers/${fx.customer.id}`).set(fx.c.auth);
      expect(full.body.leads).toHaveLength(2);
    });
  });

  describe('GET /v1/leads', () => {
    it('200: filters by stage, venue, assignee, source, customer, follow-up and search; paginates', async () => {
      const fx = await setup();
      const v2 = await makeVenue(t, fx.c.auth, { name: 'Second Hall' });
      const sara = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const second = await t
        .http()
        .post('/v1/customers')
        .set(fx.c.auth)
        .send({ name: 'Zainab Searchable', phone: '0311 8887776' });
      const a = await made(fx, { source: 'phone' });
      const b = await made(fx, { venueId: v2.id, source: 'web', assigneeId: sara.membershipId });
      const c = await made(fx, {
        customerId: second.body.id,
        source: 'whatsapp',
        assigneeId: null,
        nextFollowUpAt: inHours(-5),
      });
      await patch(fx.c.auth, a, { stage: 'CONTACTED' });

      const ids = async (query: string) => {
        const res = await t.http().get(`/v1/leads${query}`).set(fx.c.auth);
        expect(res.status, query).toBe(200);
        LeadListResponseSchema.parse(res.body);
        return res.body.data.map((l: LeadDto) => l.id) as string[];
      };
      expect((await ids('')).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(await ids('?stage=CONTACTED')).toEqual([a.id]);
      expect(await ids(`?venueId=${v2.id}`)).toEqual([b.id]);
      expect(await ids(`?assigneeId=${sara.membershipId}`)).toEqual([b.id]);
      expect(await ids('?unassigned=true')).toEqual([c.id]);
      expect(await ids('?source=whatsapp')).toEqual([c.id]);
      expect(await ids(`?customerId=${second.body.id}`)).toEqual([c.id]);
      expect(await ids('?followUp=overdue')).toEqual([c.id]);
      expect(await ids('?search=zainab')).toEqual([c.id]);
      expect(await ids('?search=0311-888')).toEqual([c.id]);
      expect(await ids('?search=%25')).toEqual([]);
      expect(await ids('?stage=WON&followUp=overdue')).toEqual([]);
      expect((await t.http().get('/v1/leads?stage=NOPE').set(fx.c.auth)).status).toBe(400);

      const page1 = await t.http().get('/v1/leads?limit=2').set(fx.c.auth);
      expect(page1.body.data).toHaveLength(2);
      const page2 = await t
        .http()
        .get(`/v1/leads?limit=2&cursor=${page1.body.nextCursor}`)
        .set(fx.c.auth);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      expect((await t.http().get('/v1/leads?cursor=garbage').set(fx.c.auth)).status).toBe(400);
    });

    it('401 without an identity; 403 without lead.view; other workspaces are invisible', async () => {
      const fx = await setup();
      const other = await setup();
      const theirs = await made(other);
      expect((await t.http().get('/v1/leads').set(t.csrfHeaders)).status).toBe(401);
      const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
      expect((await t.http().get('/v1/leads').set(memberAuth(ops, fx.c))).status).toBe(403);
      const mine = await t.http().get('/v1/leads').set(fx.c.auth);
      expect(JSON.stringify(mine.body)).not.toContain(theirs.id);
      const foreignCursor = Buffer.from(`l1:${theirs.id}`).toString('base64url');
      expect((await t.http().get(`/v1/leads?cursor=${foreignCursor}`).set(fx.c.auth)).status).toBe(
        400,
      );
      const get = await t.http().get(`/v1/leads/${theirs.id}`).set(fx.c.auth);
      expect(get.status).toBe(404);
      expect(code(get)).toBe('NOT_FOUND');
    });
  });

  describe('GET /v1/leads/follow-ups', () => {
    it('counts overdue and due-today follow-ups of open leads, mine or everyone’s', async () => {
      const fx = await setup();
      const sara = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const overdue = await made(fx, { nextFollowUpAt: inHours(-30) });
      const justPast = await made(fx, { nextFollowUpAt: inHours(-1) });
      const today = await made(fx, { nextFollowUpAt: new Date(Date.now() + 60_000).toISOString() });
      await made(fx, { nextFollowUpAt: inHours(100) });
      await made(fx, { nextFollowUpAt: inHours(-3), assigneeId: sara.membershipId });
      const closed = await made(fx, { nextFollowUpAt: inHours(-50) });
      await patch(fx.c.auth, closed, { stage: 'LOST', lostReason: 'x' });

      const mine = await t.http().get('/v1/leads/follow-ups').set(fx.c.auth);
      expect(mine.status).toBe(200);
      const parsed = LeadFollowUpsSchema.parse(mine.body);
      expect(parsed.overdue).toBe(2);
      expect(parsed.items.map((l) => l.id)).toEqual(
        [overdue.id, justPast.id, today.id].filter((id) => parsed.items.some((l) => l.id === id)),
      );
      expect(parsed.items[0]?.id).toBe(overdue.id); // oldest first
      const everyone = await t.http().get('/v1/leads/follow-ups?assignee=any').set(fx.c.auth);
      expect(everyone.body.overdue).toBe(3);
      expect((await t.http().get('/v1/leads/follow-ups?assignee=sara').set(fx.c.auth)).status).toBe(
        400,
      );
      const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
      expect((await t.http().get('/v1/leads/follow-ups').set(memberAuth(ops, fx.c))).status).toBe(
        403,
      );
    });
  });

  describe('GET /v1/leads/:id/activity', () => {
    it('lists stage changes, assignments, notes and the creation, newest first, with who did it', async () => {
      const fx = await setup();
      const sara = await world.addMember(fx.c.tenant, { role: 'sales_agent' });
      const lead = await made(fx, { notes: 'First' });
      const step1 = await patch(fx.c.auth, lead, {
        stage: 'CONTACTED',
        notes: 'Called, wants a visit',
      });
      const step2 = await patch(fx.c.auth, step1.body, { assigneeId: sara.membershipId });
      await patch(fx.c.auth, step2.body, { stage: 'LOST', lostReason: 'Too expensive' });

      const res = await t.http().get(`/v1/leads/${lead.id}/activity`).set(fx.c.auth);
      expect(res.status).toBe(200);
      const log = LeadActivityListResponseSchema.parse(res.body).data;
      expect(log.map((e) => e.action)).toEqual([
        'lead.stage_change',
        'lead.assign',
        'lead.update',
        'lead.stage_change',
        'lead.create',
      ]);
      expect(log[0]?.changes).toEqual(
        expect.arrayContaining([
          { field: 'stage', from: 'CONTACTED', to: 'LOST' },
          { field: 'lostReason', from: null, to: 'Too expensive' },
        ]),
      );
      expect(log[1]?.changes).toEqual([
        { field: 'assignee', from: expect.any(String), to: expect.any(String) },
      ]);
      expect(log[2]?.changes).toEqual([
        { field: 'notes', from: 'First', to: 'Called, wants a visit' },
      ]);
      expect(log[3]?.changes).toEqual(
        expect.arrayContaining([{ field: 'stage', from: 'NEW', to: 'CONTACTED' }]),
      );
      expect(log.every((e) => e.actorName !== null)).toBe(true);
      expect(JSON.stringify(log)).not.toContain('example.test');
    });

    it('404 for another workspace’s lead; 403 without lead.view', async () => {
      const fx = await setup();
      const other = await setup();
      const theirs = await made(other);
      expect((await t.http().get(`/v1/leads/${theirs.id}/activity`).set(fx.c.auth)).status).toBe(
        404,
      );
      const ops = await world.addMember(fx.c.tenant, { role: 'operations' });
      const mine = await made(fx);
      expect(
        (await t.http().get(`/v1/leads/${mine.id}/activity`).set(memberAuth(ops, fx.c))).status,
      ).toBe(403);
    });
  });

  describe('follow-up stamp', () => {
    it('a new follow-up time or a new assignee clears the "notified" stamp; the stamp itself does not bump rev', async () => {
      const fx = await setup();
      const lead = await made(fx);
      const stamp = (value: Date | null) =>
        world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
          tx.lead.updateMany({ where: { id: lead.id }, data: { followUpNotifiedFor: value } }),
        );
      const read = () =>
        world.db.tx({ tenantId: fx.c.tenant.id }, (tx) =>
          tx.lead.findFirstOrThrow({
            where: { id: lead.id },
            select: { rev: true, followUpNotifiedFor: true },
          }),
        );
      await stamp(new Date(lead.nextFollowUpAt as string));
      expect(await read()).toMatchObject({ rev: 1 });
      expect((await read()).followUpNotifiedFor).not.toBeNull();
      const res = await patch(fx.c.auth, lead, { nextFollowUpAt: inHours(30) });
      expect(res.body.rev).toBe(2);
      expect((await read()).followUpNotifiedFor).toBeNull();
    });
  });
});
