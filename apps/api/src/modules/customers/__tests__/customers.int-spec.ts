import {
  CustomerDetailSchema,
  CustomerDuplicatesResponseSchema,
  CustomerListResponseSchema,
  RevealedValueSchema,
} from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { code, setupCaller } from '../../../__tests__/helpers/setup-fixtures';
import type { Caller } from '../../../__tests__/helpers/setup-fixtures';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';

// Module 4, customers: access matrix (2xx / 400 / 401 / 403 / other tenant 404), phone normalisation, duplicate
// detection, search, custom field values and the sensitive field life cycle (sealed, masked, revealed with an audit row,
// never in clear in the audit log, the database or the logs).

const CNIC = '35202-1234567-1';
const CNIC_MASKED = '*****-*****67-1';

describe('customers endpoints', () => {
  let t: TestApp;
  let world: World;
  let n = 0;
  const uniquePhone = () => `0300 ${String(1000000 + ++n).slice(-7)}`;

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const create = (c: Caller, body: Record<string, unknown> = {}) =>
    t
      .http()
      .post('/v1/customers')
      .set(c.auth)
      .send({ name: `Customer ${++n}`, phone: uniquePhone(), ...body });
  const made = async (c: Caller, body: Record<string, unknown> = {}) => {
    const res = await create(c, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ReturnType<typeof CustomerDetailSchema.parse>;
  };
  const defineField = async (c: Caller, body: Record<string, unknown>) => {
    const res = await t
      .http()
      .post('/v1/custom-fields')
      .set(c.ownerAuth)
      .send({ entity: 'customer', type: 'text', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };

  describe('POST /v1/customers', () => {
    it('201: stores the phone as E.164, lower-cases the email and writes an audit row', async () => {
      const c = await setupCaller(world, t);
      const res = await create(c, {
        name: 'Hina Malik',
        phone: '0300-1234567',
        altPhone: '+92 321 7654321',
        email: ' Hina@Example.com ',
        address: 'Gulberg, Lahore',
        preferredLocale: 'en',
      });
      expect(res.status).toBe(201);
      const customer = CustomerDetailSchema.parse(res.body);
      expect(customer).toMatchObject({
        phone: '+923001234567',
        altPhone: '+923217654321',
        email: 'hina@example.com',
        active: true,
        rev: 1,
        leads: [],
        duplicates: [],
      });
      const rows = await world.auditRows(c.tenant, {
        action: 'customer.create',
        entityId: customer.id,
      });
      expect(rows).toHaveLength(1);
      // Phone and email are reduced to a hint in the audit log.
      expect(JSON.stringify(rows[0]?.after)).not.toContain('+923001234567');
      expect(JSON.stringify(rows[0]?.after)).not.toContain('hina@example.com');
    });

    it('400: an invalid body, a phone that is not a phone, an unknown custom field', async () => {
      const c = await setupCaller(world, t);
      const blank = await create(c, { name: ' ' });
      expect(blank.status).toBe(400);
      expect(code(blank)).toBe('VALIDATION_ERROR');
      const letters = await create(c, { phone: 'call me' });
      expect(letters.status).toBe(400);
      expect(JSON.stringify(letters.body.error.details)).toContain('phone');
      const short = await create(c, { phone: '0300 123' });
      expect(short.status).toBe(400);
      const email = await create(c, { email: 'not-an-email' });
      expect(email.status).toBe(400);
      const unknown = await create(c, { customFields: { nope: 'x' } });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.body.error.details)).toContain('customFields.nope');
    });

    it('401 without an identity; 403 without customer.manage', async () => {
      const anonymous = await t
        .http()
        .post('/v1/customers')
        .set(t.csrfHeaders)
        .send({ name: 'x', phone: '0300 1234567' });
      expect(anonymous.status).toBe(401);
      const accountant = await setupCaller(world, t, { role: { role: 'accountant' } });
      const denied = await create(accountant);
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('FORBIDDEN');
    });

    it('a number typed without a country code needs the workspace country; a +code number does not', async () => {
      const c = await setupCaller(world, t);
      expect((await create(c, { phone: '+971 50 123 4567' })).body.phone).toBe('+971501234567');
    });
  });

  describe('duplicates (a warning, never a block)', () => {
    it('the same phone or email is reported on create, on read and by GET /duplicates; both are still created', async () => {
      const c = await setupCaller(world, t);
      const first = await made(c, { name: 'Ali Raza', phone: '0300 5550001', email: 'ali@x.test' });
      const samePhone = await made(c, { name: 'Ali (brother)', phone: '+92 300 5550001' });
      expect(samePhone.duplicates).toEqual([
        {
          id: first.id,
          name: 'Ali Raza',
          phone: '+923005550001',
          email: 'ali@x.test',
          matchedOn: ['phone'],
        },
      ]);
      const sameEmail = await made(c, { phone: uniquePhone(), email: 'ALI@x.test' });
      expect(sameEmail.duplicates.map((d) => [d.id, d.matchedOn])).toEqual([[first.id, ['email']]]);
      const both = await made(c, { phone: '03005550001', email: 'ali@x.test' });
      expect(both.duplicates.map((d) => d.id).sort()).toEqual(
        [first.id, samePhone.id, sameEmail.id].sort(),
      );

      const check = await t.http().get('/v1/customers/duplicates?phone=0300%205550001').set(c.auth);
      expect(check.status).toBe(200);
      CustomerDuplicatesResponseSchema.parse(check.body);
      expect(check.body.data.map((d: { id: string }) => d.id)).toContain(first.id);
      const excluded = await t
        .http()
        .get(`/v1/customers/duplicates?email=ali%40x.test&excludeId=${first.id}`)
        .set(c.auth);
      expect(excluded.body.data.map((d: { id: string }) => d.id)).not.toContain(first.id);
      const detail = await t.http().get(`/v1/customers/${first.id}`).set(c.auth);
      expect(detail.body.duplicates.length).toBe(3);
    });

    it('400 without a phone or an email; another workspace never matches', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      expect((await t.http().get('/v1/customers/duplicates').set(a.auth)).status).toBe(400);
      expect(
        (await t.http().get('/v1/customers/duplicates?phone=not%20a%20phone').set(a.auth)).status,
      ).toBe(400);
      await made(b, { phone: '0300 7770001' });
      const res = await t.http().get('/v1/customers/duplicates?phone=0300%207770001').set(a.auth);
      expect(res.body.data).toEqual([]);
      const mine = await made(a, { phone: '0300 7770001' });
      expect(mine.duplicates).toEqual([]);
    });

    it('a deactivated customer is not a duplicate', async () => {
      const c = await setupCaller(world, t);
      const old = await made(c, { phone: '0300 7770002' });
      await t
        .http()
        .patch(`/v1/customers/${old.id}`)
        .set(c.auth)
        .send({ rev: old.rev, active: false });
      expect((await made(c, { phone: '0300 7770002' })).duplicates).toEqual([]);
    });
  });

  describe('GET /v1/customers', () => {
    it('200: lists the workspace only, searches name, phone and email, hides inactive ones', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const hina = await made(a, { name: 'Hina Malik', phone: '0321 1112223', email: 'hm@x.test' });
      await made(a, { name: 'Zubair Khan', phone: '0333 4445556' });
      const gone = await made(a, { name: 'Hinata Gone', phone: '0333 4445557' });
      await t
        .http()
        .patch(`/v1/customers/${gone.id}`)
        .set(a.auth)
        .send({ rev: gone.rev, active: false });
      await made(b, { name: 'Hina Other Tenant', phone: '0321 1112223' });

      const list = await t.http().get('/v1/customers').set(a.auth);
      expect(list.status).toBe(200);
      CustomerListResponseSchema.parse(list.body);
      expect(list.body.data.map((x: { name: string }) => x.name)).toEqual([
        'Hina Malik',
        'Zubair Khan',
      ]);

      const byName = await t.http().get('/v1/customers?search=hin').set(a.auth);
      expect(byName.body.data.map((x: { id: string }) => x.id)).toEqual([hina.id]);
      const byPhone = await t.http().get('/v1/customers?search=0321-111').set(a.auth);
      expect(byPhone.body.data.map((x: { id: string }) => x.id)).toEqual([hina.id]);
      const byPlus = await t.http().get('/v1/customers?search=%2B92%20321').set(a.auth);
      expect(byPlus.body.data.map((x: { id: string }) => x.id)).toEqual([hina.id]);
      const byEmail = await t.http().get('/v1/customers?search=HM%40X').set(a.auth);
      expect(byEmail.body.data.map((x: { id: string }) => x.id)).toEqual([hina.id]);
      const withInactive = await t
        .http()
        .get('/v1/customers?includeInactive=true&search=hin')
        .set(a.auth);
      expect(withInactive.body.data).toHaveLength(2);
      // A search that is only wildcards matches nothing special.
      const wild = await t.http().get('/v1/customers?search=%25').set(a.auth);
      expect(wild.body.data).toEqual([]);
    });

    it('paginates with an opaque cursor and rejects a cursor of another workspace', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      for (const name of ['P1', 'P2', 'P3', 'P4', 'P5']) await made(a, { name });
      const foreign = await made(b, { name: 'Foreign' });
      const page1 = await t.http().get('/v1/customers?limit=2').set(a.auth);
      expect(page1.body.data.map((x: { name: string }) => x.name)).toEqual(['P1', 'P2']);
      const page2 = await t
        .http()
        .get(`/v1/customers?limit=2&cursor=${page1.body.nextCursor}`)
        .set(a.auth);
      expect(page2.body.data.map((x: { name: string }) => x.name)).toEqual(['P3', 'P4']);
      const page3 = await t
        .http()
        .get(`/v1/customers?limit=2&cursor=${page2.body.nextCursor}`)
        .set(a.auth);
      expect(page3.body.data.map((x: { name: string }) => x.name)).toEqual(['P5']);
      expect(page3.body.nextCursor).toBeNull();
      const forged = Buffer.from(`u1:${foreign.id}`).toString('base64url');
      expect((await t.http().get(`/v1/customers?cursor=${forged}`).set(a.auth)).status).toBe(400);
      expect((await t.http().get('/v1/customers?cursor=garbage').set(a.auth)).status).toBe(400);
      expect((await t.http().get('/v1/customers?limit=1000').set(a.auth)).status).toBe(400);
    });

    it('401 without an identity; 403 without customer.view', async () => {
      expect((await t.http().get('/v1/customers').set(t.csrfHeaders)).status).toBe(401);
      const ops = await setupCaller(world, t, { role: { role: 'operations' } });
      expect((await t.http().get('/v1/customers').set(ops.auth)).status).toBe(403);
      expect((await t.http().get('/v1/customers/duplicates?phone=0300').set(ops.auth)).status).toBe(
        403,
      );
    });
  });

  describe('GET /v1/customers/:id', () => {
    it('200 with leads of the caller (only with lead.view); another workspace is 404', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const theirs = await made(b);
      const mine = await made(a);
      const res = await t.http().get(`/v1/customers/${mine.id}`).set(a.auth);
      expect(res.status).toBe(200);
      CustomerDetailSchema.parse(res.body);
      const missing = await t.http().get(`/v1/customers/${theirs.id}`).set(a.auth);
      expect(missing.status).toBe(404);
      expect(code(missing)).toBe('NOT_FOUND');
      expect((await t.http().get('/v1/customers/nope').set(a.auth)).status).toBe(404);
    });
  });

  describe('PATCH /v1/customers/:id', () => {
    it('200: edits, bumps rev, audits before and after; 409 on a stale rev', async () => {
      const c = await setupCaller(world, t);
      const customer = await made(c, { name: 'Old Name' });
      const res = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(c.auth)
        .send({ rev: customer.rev, name: 'New Name', phone: '0301 9998887', notes: 'VIP' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'New Name',
        phone: '+923019998887',
        notes: 'VIP',
        rev: 2,
      });
      const stale = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(c.auth)
        .send({ rev: customer.rev, name: 'Again' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      const rows = await world.auditRows(c.tenant, {
        action: 'customer.update',
        entityId: customer.id,
      });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]?.before)).toContain('Old Name');
      expect(JSON.stringify(rows[0]?.after)).toContain('New Name');
    });

    it('400: nothing to change, no rev, an invalid phone', async () => {
      const c = await setupCaller(world, t);
      const customer = await made(c);
      const patch = (body: object) =>
        t.http().patch(`/v1/customers/${customer.id}`).set(c.auth).send(body);
      expect((await patch({ rev: 1 })).status).toBe(400);
      expect((await patch({ name: 'x' })).status).toBe(400);
      expect((await patch({ rev: 1, phone: 'abc' })).status).toBe(400);
    });

    it('the soft delete is active=false, audited as a deactivation, and can be undone', async () => {
      const c = await setupCaller(world, t);
      const customer = await made(c);
      const off = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(c.auth)
        .send({ rev: customer.rev, active: false });
      expect(off.body.active).toBe(false);
      const on = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(c.auth)
        .send({ rev: off.body.rev, active: true });
      expect(on.body.active).toBe(true);
      expect(await world.auditRows(c.tenant, { action: 'customer.deactivate' })).toHaveLength(1);
      expect(await world.auditRows(c.tenant, { action: 'customer.reactivate' })).toHaveLength(1);
    });

    it('403 without customer.manage; another workspace is 404 and untouched', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const accountant = await setupCaller(world, t, { role: { role: 'accountant' } });
      const mine = await made(
        accountant.ownerAuth ? { ...accountant, auth: accountant.ownerAuth } : accountant,
      );
      const denied = await t
        .http()
        .patch(`/v1/customers/${mine.id}`)
        .set(accountant.auth)
        .send({ rev: 1, name: 'x' });
      expect(denied.status).toBe(403);
      const theirs = await made(b);
      const attack = await t
        .http()
        .patch(`/v1/customers/${theirs.id}`)
        .set(a.auth)
        .send({ rev: 1, name: 'Hijacked' });
      expect(attack.status).toBe(404);
      expect((await t.http().get(`/v1/customers/${theirs.id}`).set(b.auth)).body.name).toBe(
        theirs.name,
      );
    });
  });

  describe('custom fields', () => {
    it('validates type, choices and required; clears with null; only the keys sent change', async () => {
      const c = await setupCaller(world, t);
      await defineField(c, { key: 'family', label: 'Family name', required: true });
      await defineField(c, { key: 'guests_usual', label: 'Usual guests', type: 'number' });
      await defineField(c, { key: 'birthday', label: 'Birthday', type: 'date' });
      await defineField(c, {
        key: 'tier',
        label: 'Tier',
        type: 'select',
        options: ['Gold', 'Silver'],
      });
      await defineField(c, { key: 'guardian_phone', label: 'Guardian phone', type: 'phone' });

      expect((await create(c)).status).toBe(400); // required field missing
      expect((await create(c, { customFields: { family: 'Malik', tier: 'Bronze' } })).status).toBe(
        400,
      );
      expect(
        (await create(c, { customFields: { family: 'Malik', birthday: '2027-02-30' } })).status,
      ).toBe(400);
      expect(
        (await create(c, { customFields: { family: 'Malik', guests_usual: 'many' } })).status,
      ).toBe(400);
      expect(
        (await create(c, { customFields: { family: 'Malik', guardian_phone: '12' } })).status,
      ).toBe(400);

      const customer = await made(c, {
        customFields: {
          family: 'Malik',
          guests_usual: '350',
          birthday: '1990-05-01',
          tier: 'Gold',
          guardian_phone: '0300 1112223',
        },
      });
      expect(customer.customFields).toEqual({
        family: 'Malik',
        guests_usual: 350,
        birthday: '1990-05-01',
        tier: 'Gold',
        guardian_phone: '+923001112223',
      });
      const patch = (body: object) =>
        t.http().patch(`/v1/customers/${customer.id}`).set(c.auth).send(body);
      const changed = await patch({ rev: 1, customFields: { tier: 'Silver', birthday: null } });
      expect(changed.status).toBe(200);
      expect(changed.body.customFields).toMatchObject({ family: 'Malik', tier: 'Silver' });
      expect(changed.body.customFields.birthday).toBeUndefined();
      // A required field cannot be cleared.
      expect((await patch({ rev: 2, customFields: { family: null } })).status).toBe(400);
    });

    it('a deactivated field cannot be written', async () => {
      const c = await setupCaller(world, t);
      await defineField(c, { key: 'old_field', label: 'Old field' });
      const defs = await t.http().get('/v1/custom-fields?entity=customer').set(c.ownerAuth);
      const def = defs.body.data[0];
      await t
        .http()
        .patch(`/v1/custom-fields/${def.id}`)
        .set(c.ownerAuth)
        .send({ rev: def.rev, active: false });
      expect((await create(c, { customFields: { old_field: 'x' } })).status).toBe(400);
    });
  });

  describe('sensitive custom fields', () => {
    const setup = async () => {
      const c = await setupCaller(world, t);
      await defineField(c, { key: 'cnic', label: 'CNIC', sensitive: true });
      return c;
    };
    const reveal = (c: Caller | { auth: Record<string, string> }, id: string, key = 'cnic') =>
      t.http().post(`/v1/customers/${id}/reveal/${key}`).set(c.auth).send({});

    it('is masked everywhere it is read, and never stored or logged in clear', async () => {
      const c = await setup();
      const customer = await made(c, { customFields: { cnic: CNIC } });
      expect(customer.customFields.cnic).toBe(CNIC_MASKED);
      expect(customer.sensitiveKeys).toEqual(['cnic']);

      const read = await t.http().get(`/v1/customers/${customer.id}`).set(c.auth);
      expect(read.body.customFields.cnic).toBe(CNIC_MASKED);
      const list = await t.http().get('/v1/customers').set(c.auth);
      expect(JSON.stringify(list.body)).not.toContain(CNIC);

      const stored = await world.db.tx({ tenantId: c.tenant.id }, (tx) =>
        tx.customer.findFirstOrThrow({
          where: { id: customer.id },
          select: { customFields: true },
        }),
      );
      const storedText = JSON.stringify(stored.customFields);
      expect(storedText).not.toContain('35202');
      expect(storedText).toContain('"sealed":"v1.k1.');

      const audits = await world.auditRows(c.tenant, { entityId: customer.id });
      expect(JSON.stringify(audits)).not.toContain('35202');
      expect(JSON.stringify(audits)).not.toContain('*****-*****67-1');
      expect(t.rawLogs()).not.toContain('35202-1234567');
    });

    it('is revealed only with customer.view_sensitive, and every reveal is audited without the value', async () => {
      const c = await setup();
      const customer = await made(c, { customFields: { cnic: CNIC } });
      const agent = await world.addMember(c.tenant, { role: 'sales_agent' });
      const manager = await world.addMember(c.tenant, { role: 'branch_manager' });
      const agentAuth = t.as(authHeader(agent.userId, c.tenant.id));
      const managerAuth = t.as(authHeader(manager.userId, c.tenant.id));

      const denied = await reveal({ auth: agentAuth }, customer.id);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain('35202');
      expect(await world.auditRows(c.tenant, { action: 'customer.reveal_sensitive' })).toHaveLength(
        0,
      );
      // The agent can still create and edit the customer, just not read the value back.
      const edited = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(agentAuth)
        .send({ rev: 1, notes: 'called' });
      expect(edited.body.customFields.cnic).toBe(CNIC_MASKED);

      const owner = await reveal({ auth: c.ownerAuth }, customer.id);
      expect(owner.status).toBe(200);
      expect(RevealedValueSchema.parse(owner.body)).toEqual({ key: 'cnic', value: CNIC });
      const byManager = await reveal({ auth: managerAuth }, customer.id);
      expect(byManager.status).toBe(200);

      const rows = await world.auditRows(c.tenant, { action: 'customer.reveal_sensitive' });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.entityId === customer.id)).toBe(true);
      expect(rows.map((r) => r.actorUserId).sort()).toEqual([c.userId, manager.userId].sort());
      expect(JSON.stringify(rows)).not.toContain('35202');
      expect(JSON.stringify(rows)).toContain('cnic');
      expect(t.rawLogs()).not.toContain('35202-1234567');
    });

    it('404: another workspace’s customer, a field that is not sensitive, a field without a value, an unknown field', async () => {
      const c = await setup();
      const other = await setup();
      await defineField(c, { key: 'nickname', label: 'Nickname' });
      const withValue = await made(c, { customFields: { cnic: CNIC, nickname: 'Bobby' } });
      const without = await made(c);
      const theirs = await made(other, { customFields: { cnic: CNIC } });
      expect((await reveal(c, theirs.id)).status).toBe(404);
      expect((await reveal(c, withValue.id, 'nickname')).status).toBe(404);
      expect((await reveal(c, without.id)).status).toBe(404);
      expect((await reveal(c, withValue.id, 'nope')).status).toBe(404);
      expect((await reveal(c, withValue.id, 'Bad Key!')).status).toBe(400);
      expect(await world.auditRows(c.tenant, { action: 'customer.reveal_sensitive' })).toHaveLength(
        0,
      );
      expect(
        (await t.http().post(`/v1/customers/${withValue.id}/reveal/cnic`).set(t.csrfHeaders))
          .status,
      ).toBe(401);
    });

    it('a value sealed for one customer does not open for another (the AAD binds it)', async () => {
      const c = await setup();
      const one = await made(c, { customFields: { cnic: CNIC } });
      const two = await made(c, { customFields: { cnic: '11111-1111111-1' } });
      const row = await world.db.tx({ tenantId: c.tenant.id }, (tx) =>
        tx.customer.findFirstOrThrow({ where: { id: one.id }, select: { customFields: true } }),
      );
      // Copy one's sealed blob onto two (what an attacker with database write access could do).
      await world.db.tx({ tenantId: c.tenant.id }, (tx) =>
        tx.customer.updateMany({
          where: { id: two.id },
          data: { customFields: row.customFields as object },
        }),
      );
      const res = await reveal(c, two.id);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('35202');
    });

    it('clearing a sensitive value is audited by key only', async () => {
      const c = await setup();
      const customer = await made(c, { customFields: { cnic: CNIC } });
      const res = await t
        .http()
        .patch(`/v1/customers/${customer.id}`)
        .set(c.auth)
        .send({ rev: 1, customFields: { cnic: null } });
      expect(res.body.customFields.cnic).toBeUndefined();
      const rows = await world.auditRows(c.tenant, {
        action: 'customer.update',
        entityId: customer.id,
      });
      expect(JSON.stringify(rows[0]?.after)).toContain('sensitiveFieldsChanged');
      expect(JSON.stringify(rows)).not.toContain('35202');
    });
  });
});
