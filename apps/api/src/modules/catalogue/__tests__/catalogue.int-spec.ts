import { AddOnSchema, CustomFieldDefSchema, MenuItemSchema, PackageSchema } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { crudMatrix, nextN } from '../../../__tests__/helpers/crud-matrix';
import { code, setupCaller } from '../../../__tests__/helpers/setup-fixtures';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';

// Module 3, catalogue: menu items, packages, add-ons, custom field definitions. The shared access matrix
// (crud-matrix.ts) covers 2xx / 400 / 401 / 403 / other-tenant 404 / rev / audit for each; the rest is specific rules.

describe('catalogue endpoints', () => {
  let t: TestApp;
  let world: World;
  const env = () => ({ t, world });

  beforeAll(async () => {
    world = new World();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  describe('menu items', () => {
    crudMatrix(
      {
        path: '/v1/menu-items',
        create: (n) => ({ name: `Chicken karahi ${n}`, category: 'Main' }),
        invalid: { name: ' ' },
        change: { category: 'Dessert' },
        changed: { category: 'Dessert' },
        audit: { create: 'menu_item.create', update: 'menu_item.update' },
        parse: (b) => MenuItemSchema.parse(b),
        uniqueName: 'name',
        softDelete: true,
      },
      env,
    );

    it('filters by category, ignoring case, and clears a category with null', async () => {
      const { auth } = await setupCaller(world, t);
      const make = (name: string, category: string | null) =>
        t.http().post('/v1/menu-items').set(auth).send({ name, category });
      await make('Seekh kebab', 'Starter');
      const naan = (await make('Naan', 'Bread')).body;
      await make('Water', null);
      const starters = await t.http().get('/v1/menu-items?category=starter').set(auth);
      expect(starters.body.data.map((m: { name: string }) => m.name)).toEqual(['Seekh kebab']);
      const cleared = await t
        .http()
        .patch(`/v1/menu-items/${naan.id}`)
        .set(auth)
        .send({ rev: naan.rev, category: null });
      expect(cleared.body.category).toBeNull();
    });
  });

  describe('add-ons', () => {
    crudMatrix(
      {
        path: '/v1/add-ons',
        create: (n) => ({ name: `DJ ${n}`, pricing: 'FIXED', price: '5000' }),
        invalid: { name: 'DJ', pricing: 'PER_DAY', price: '5000' },
        change: { price: '6500.5', pricing: 'PER_HOUR' },
        changed: { price: '6500.50', pricing: 'PER_HOUR' },
        audit: { create: 'add_on.create', update: 'add_on.update' },
        parse: (b) => AddOnSchema.parse(b),
        uniqueName: 'name',
        softDelete: true,
      },
      env,
    );

    it('supports the four pricing kinds and writes the price with the currency decimals', async () => {
      const { auth } = await setupCaller(world, t);
      for (const pricing of ['FIXED', 'PER_HEAD', 'PER_HOUR', 'PER_UNIT']) {
        const res = await t
          .http()
          .post('/v1/add-ons')
          .set(auth)
          .send({ name: `Item ${pricing}`, pricing, price: '250' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ pricing, price: '250.00' });
      }
    });

    it('400: more decimals than the currency has (PKR 2)', async () => {
      const { auth } = await setupCaller(world, t);
      const res = await t
        .http()
        .post('/v1/add-ons')
        .set(auth)
        .send({ name: 'Precise', pricing: 'FIXED', price: '10.005' });
      expect(res.status).toBe(400);
      expect(code(res)).toBe('VALIDATION_ERROR');
    });

    it('hides the price from a reader who may not see prices (Operations)', async () => {
      const { tenant, ownerAuth } = await setupCaller(world, t);
      const created = await t
        .http()
        .post('/v1/add-ons')
        .set(ownerAuth)
        .send({ name: 'Projector', pricing: 'PER_HOUR', price: '1500' });
      const ops = await world.addMember(tenant, { role: 'operations' });
      const opsAuth = t.as(authHeader(ops.userId, tenant.id));
      const list = await t.http().get('/v1/add-ons').set(opsAuth);
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toMatchObject({ name: 'Projector', price: null });
      expect(
        (await t.http().get(`/v1/add-ons/${created.body.id}`).set(opsAuth)).body.price,
      ).toBeNull();
      // The Owner (and a Sales agent, who may see booking prices) see it.
      expect((await t.http().get('/v1/add-ons').set(ownerAuth)).body.data[0].price).toBe('1500.00');
    });
  });

  describe('packages', () => {
    crudMatrix(
      {
        path: '/v1/packages',
        create: (n) => ({ name: `Menu ${n}`, perHeadRate: '1500', minGuests: 100 }),
        invalid: { name: 'Bad', perHeadRate: '-1' },
        change: { perHeadRate: '1750.5', minGuests: 150 },
        changed: { perHeadRate: '1750.50', minGuests: 150 },
        audit: { create: 'package.create', update: 'package.update' },
        parse: (b) => PackageSchema.parse(b),
        uniqueName: 'name',
        softDelete: true,
      },
      env,
    );

    const dish = async (auth: Record<string, string>, name: string) =>
      (await t.http().post('/v1/menu-items').set(auth).send({ name, category: 'Main' })).body as {
        id: string;
        rev: number;
      };

    it('201: a package with dishes and quantities; items are listed with names, sorted', async () => {
      const { auth } = await setupCaller(world, t);
      const rice = await dish(auth, 'Pulao');
      const karahi = await dish(auth, 'Karahi');
      const res = await t
        .http()
        .post('/v1/packages')
        .set(auth)
        .send({
          name: 'Platinum',
          perHeadRate: '2200',
          minGuests: 200,
          description: 'Three mains',
          items: [{ menuItemId: rice.id, quantity: 2 }, { menuItemId: karahi.id }],
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.items).toEqual([
        {
          menuItemId: karahi.id,
          name: 'Karahi',
          category: 'Main',
          quantity: 1,
          menuItemActive: true,
        },
        { menuItemId: rice.id, name: 'Pulao', category: 'Main', quantity: 2, menuItemActive: true },
      ]);
      expect(res.body).toMatchObject({ perHeadRate: '2200.00', description: 'Three mains' });
    });

    it('404: a dish of another tenant (or one that does not exist); the package is not created', async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const theirs = await dish(b.auth, 'Secret dish');
      const res = await t
        .http()
        .post('/v1/packages')
        .set(a.auth)
        .send({ name: 'Sneaky', perHeadRate: '100', items: [{ menuItemId: theirs.id }] });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Secret dish');
      const list = await t.http().get('/v1/packages?includeInactive=true').set(a.auth);
      expect(list.body.data).toEqual([]);
    });

    it('400: a deactivated dish cannot be added, but one already in the package may stay', async () => {
      const { auth } = await setupCaller(world, t);
      const keep = await dish(auth, 'Keep');
      const pkg = (
        await t
          .http()
          .post('/v1/packages')
          .set(auth)
          .send({ name: 'Mixed', perHeadRate: '100', items: [{ menuItemId: keep.id }] })
      ).body;
      await t
        .http()
        .patch(`/v1/menu-items/${keep.id}`)
        .set(auth)
        .send({ rev: keep.rev, active: false });
      const stillThere = await t.http().get(`/v1/packages/${pkg.id}`).set(auth);
      expect(stillThere.body.items[0]).toMatchObject({ name: 'Keep', menuItemActive: false });
      // Saving the same list again is fine ...
      const same = await t
        .http()
        .patch(`/v1/packages/${pkg.id}`)
        .set(auth)
        .send({ rev: pkg.rev, items: [{ menuItemId: keep.id, quantity: 3 }] });
      expect(same.status).toBe(200);
      expect(same.body.items[0].quantity).toBe(3);
      // ... adding it to another package is not.
      const other = await t
        .http()
        .post('/v1/packages')
        .set(auth)
        .send({ name: 'Other', perHeadRate: '100', items: [{ menuItemId: keep.id }] });
      expect(other.status).toBe(400);
    });

    it('PATCH items replaces the whole list, and an empty list clears it', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const one = await dish(auth, 'One');
      const two = await dish(auth, 'Two');
      const pkg = (
        await t
          .http()
          .post('/v1/packages')
          .set(auth)
          .send({ name: 'Swap', perHeadRate: '100', items: [{ menuItemId: one.id }] })
      ).body;
      const swapped = await t
        .http()
        .patch(`/v1/packages/${pkg.id}`)
        .set(auth)
        .send({ rev: pkg.rev, items: [{ menuItemId: two.id }] });
      expect(swapped.body.items.map((i: { name: string }) => i.name)).toEqual(['Two']);
      expect(swapped.body.rev).toBe(pkg.rev + 1);
      const cleared = await t
        .http()
        .patch(`/v1/packages/${pkg.id}`)
        .set(auth)
        .send({ rev: swapped.body.rev, items: [] });
      expect(cleared.body.items).toEqual([]);
      const audit = await world.auditRows(tenant, { action: 'package.update', entityId: pkg.id });
      expect(audit).toHaveLength(2);
    });

    it('400: the same dish twice, a quantity of 0, more decimals than the currency', async () => {
      const { auth } = await setupCaller(world, t);
      const d = await dish(auth, 'Dup');
      const body = { name: 'Bad', perHeadRate: '100' };
      const twice = await t
        .http()
        .post('/v1/packages')
        .set(auth)
        .send({ ...body, items: [{ menuItemId: d.id }, { menuItemId: d.id }] });
      expect(twice.status).toBe(400);
      expect(
        (
          await t
            .http()
            .post('/v1/packages')
            .set(auth)
            .send({ ...body, items: [{ menuItemId: d.id, quantity: 0 }] })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .post('/v1/packages')
            .set(auth)
            .send({ ...body, perHeadRate: '1.005' })
        ).status,
      ).toBe(400);
    });

    it('hides the per-head rate from Operations, who still see the dishes', async () => {
      const { tenant, ownerAuth } = await setupCaller(world, t);
      const d = await dish(ownerAuth, 'Visible dish');
      await t
        .http()
        .post('/v1/packages')
        .set(ownerAuth)
        .send({ name: 'Hidden price', perHeadRate: '999', items: [{ menuItemId: d.id }] });
      const ops = await world.addMember(tenant, { role: 'operations' });
      const res = await t
        .http()
        .get('/v1/packages')
        .set(t.as(authHeader(ops.userId, tenant.id)));
      expect(res.body.data[0].perHeadRate).toBeNull();
      expect(res.body.data[0].items[0].name).toBe('Visible dish');
    });
  });

  describe('custom field definitions', () => {
    crudMatrix(
      {
        path: '/v1/custom-fields',
        create: (n) => ({
          entity: 'customer',
          key: `field_${n}`,
          label: `Field ${n}`,
          type: 'text',
        }),
        invalid: { entity: 'invoice', key: 'Bad Key', label: '', type: 'text' },
        change: { label: 'Family name', required: true },
        changed: { label: 'Family name', required: true },
        audit: { create: 'custom_field.create', update: 'custom_field.update' },
        parse: (b) => CustomFieldDefSchema.parse(b),
        softDelete: true,
      },
      env,
    );

    const field = (auth: Record<string, string>, body: Record<string, unknown>) =>
      t.http().post('/v1/custom-fields').set(auth).send(body);

    it('409: a key is reserved per record type for good, even when the field is deactivated', async () => {
      const { auth } = await setupCaller(world, t);
      const body = {
        entity: 'customer',
        key: 'cnic',
        label: 'CNIC',
        type: 'text',
        sensitive: true,
      };
      const first = await field(auth, body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ sensitive: true, options: [] });
      expect((await field(auth, body)).status).toBe(409);
      await t
        .http()
        .patch(`/v1/custom-fields/${first.body.id}`)
        .set(auth)
        .send({ rev: first.body.rev, active: false });
      const again = await field(auth, body);
      expect(again.status).toBe(409);
      expect(code(again)).toBe('DUPLICATE');
      // The same key on another record type is a different field.
      expect((await field(auth, { ...body, entity: 'lead' })).status).toBe(201);
    });

    it('a choice field needs choices; the others have none; only text-like types are sensitive', async () => {
      const { auth } = await setupCaller(world, t);
      const base = { entity: 'booking', label: 'Thing' };
      expect((await field(auth, { ...base, key: 'a1', type: 'select' })).status).toBe(400);
      expect((await field(auth, { ...base, key: 'a2', type: 'text', options: ['x'] })).status).toBe(
        400,
      );
      expect(
        (await field(auth, { ...base, key: 'a3', type: 'date', sensitive: true })).status,
      ).toBe(400);
      const select = await field(auth, {
        ...base,
        key: 'a4',
        type: 'select',
        options: ['Bride', 'Groom'],
      });
      expect(select.status).toBe(201);
      expect(select.body.options).toEqual(['Bride', 'Groom']);
    });

    it('options change only on a choice field and never become empty; key, type and entity are fixed', async () => {
      const { auth } = await setupCaller(world, t);
      const text = (await field(auth, { entity: 'session', key: 't1', label: 'T', type: 'text' }))
        .body;
      const onText = await t
        .http()
        .patch(`/v1/custom-fields/${text.id}`)
        .set(auth)
        .send({ rev: text.rev, options: ['x'] });
      expect(onText.status).toBe(400);
      const select = (
        await field(auth, {
          entity: 'session',
          key: 's1',
          label: 'S',
          type: 'select',
          options: ['A'],
        })
      ).body;
      const path = `/v1/custom-fields/${select.id}`;
      expect(
        (await t.http().patch(path).set(auth).send({ rev: select.rev, options: [] })).status,
      ).toBe(400);
      const more = await t
        .http()
        .patch(path)
        .set(auth)
        .send({ rev: select.rev, options: ['A', 'B'] });
      expect(more.body.options).toEqual(['A', 'B']);
      // `key` is not part of the patch schema: unknown keys are stripped, and with nothing else it is "nothing to change".
      expect(
        (await t.http().patch(path).set(auth).send({ rev: more.body.rev, key: 'renamed' })).status,
      ).toBe(400);
    });

    it('lists by record type and in the order of sortOrder', async () => {
      const { auth } = await setupCaller(world, t);
      await field(auth, { entity: 'lead', key: 'zz', label: 'Last', type: 'text', sortOrder: 20 });
      await field(auth, { entity: 'lead', key: 'aa', label: 'First', type: 'text', sortOrder: 10 });
      await field(auth, {
        entity: 'customer',
        key: `c${nextN()}`,
        label: 'Customer one',
        type: 'phone',
      });
      const leads = await t.http().get('/v1/custom-fields?entity=lead').set(auth);
      expect(leads.body.data.map((f: { label: string }) => f.label)).toEqual(['First', 'Last']);
      expect((await t.http().get('/v1/custom-fields?entity=invoice').set(auth)).status).toBe(400);
    });
  });
});
