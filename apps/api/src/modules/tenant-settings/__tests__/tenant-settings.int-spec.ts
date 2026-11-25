import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantSettingsResponseSchema } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { code, setupCaller } from '../../../__tests__/helpers/setup-fixtures';
import { World } from '../../../__tests__/helpers/world';

describe('tenant settings endpoints', () => {
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

  describe('GET /v1/tenant/settings', () => {
    it('200: workspace facts and every setting with its default', async () => {
      const { auth } = await setupCaller(world, t);
      const res = await t.http().get('/v1/tenant/settings').set(auth);
      expect(res.status).toBe(200);
      const body = TenantSettingsResponseSchema.parse(res.body);
      expect(body).toMatchObject({
        country: 'PK',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
        rev: 1,
        settings: {
          bookingPrefix: 'BK',
          holdHours: 48,
          advancePct: 50,
          tokenAmount: '0',
          balanceDueDays: 7,
          guestLockDays: 3,
          reminderDays: 3,
          eventReminderDays: 2,
          minHours: 2,
        },
      });
    });

    it('403: without tenant.settings.manage (a Branch manager has venue.manage only)', async () => {
      const { auth } = await setupCaller(world, t, { role: { role: 'branch_manager' } });
      const res = await t.http().get('/v1/tenant/settings').set(auth);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('401: no identity', async () => {
      expect((await t.http().get('/v1/tenant/settings')).status).toBe(401);
    });

    it("only shows the caller's own workspace", async () => {
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const mine = await t.http().get('/v1/tenant/settings').set(a.auth);
      const theirs = await t.http().get('/v1/tenant/settings').set(b.auth);
      expect(mine.body.slug).not.toBe(theirs.body.slug);
    });
  });

  describe('PATCH /v1/tenant/settings', () => {
    it('200: changes only the keys sent, keeps the others, audits before and after', async () => {
      const { auth, tenant } = await setupCaller(world, t);
      const first = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(auth)
        .send({ rev: 1, settings: { holdHours: 24, bookingPrefix: 'HALL' } });
      expect(first.status).toBe(200);
      expect(first.body.settings).toMatchObject({
        holdHours: 24,
        bookingPrefix: 'HALL',
        advancePct: 50,
      });
      expect(first.body.rev).toBe(2);

      // A second patch naming other keys must not reset the first one's keys to defaults.
      const second = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(auth)
        .send({
          rev: 2,
          name: 'Grand Banquets',
          timezone: 'Asia/Dubai',
          settings: { advancePct: 30, tokenAmount: '5000.50' },
        });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        name: 'Grand Banquets',
        timezone: 'Asia/Dubai',
        currency: 'PKR',
        settings: { holdHours: 24, bookingPrefix: 'HALL', advancePct: 30, tokenAmount: '5000.50' },
      });
      const audit = await world.auditRows(tenant, { action: 'tenant.settings.update' });
      expect(audit).toHaveLength(2);
      expect(audit[1]?.before).toMatchObject({ settings: { advancePct: 50, holdHours: 24 } });
      expect(audit[1]?.after).toMatchObject({ settings: { advancePct: 30 } });
    });

    it('400: out-of-range values, bad prefix, unknown zone, 3 decimals in PKR, nothing to change', async () => {
      const { auth } = await setupCaller(world, t);
      const patch = (body: Record<string, unknown>) =>
        t
          .http()
          .patch('/v1/tenant/settings')
          .set(auth)
          .send({ rev: 1, ...body });
      expect((await patch({ settings: { advancePct: 101 } })).status).toBe(400);
      expect((await patch({ settings: { holdHours: 0 } })).status).toBe(400);
      expect((await patch({ settings: { bookingPrefix: 'bad prefix' } })).status).toBe(400);
      expect((await patch({ timezone: 'Mars/Base' })).status).toBe(400);
      const decimals = await patch({ settings: { tokenAmount: '10.005' } });
      expect(decimals.status).toBe(400);
      expect(code(decimals)).toBe('VALIDATION_ERROR');
      expect((await patch({})).status).toBe(400);
      expect(
        (await t.http().patch('/v1/tenant/settings').set(auth).send({ name: 'X' })).status,
      ).toBe(400);
    });

    it('does not let the client change currency or country', async () => {
      const { auth } = await setupCaller(world, t);
      const res = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(auth)
        .send({ rev: 1, name: 'Same', currency: 'USD', country: 'AE' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ currency: 'PKR', country: 'PK' });
    });

    it('409: a stale rev', async () => {
      const { auth } = await setupCaller(world, t);
      await t.http().patch('/v1/tenant/settings').set(auth).send({ rev: 1, name: 'One' });
      const stale = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(auth)
        .send({ rev: 1, name: 'Two' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
    });

    it('403: without tenant.settings.manage; 403 TENANT_SUSPENDED when suspended', async () => {
      const bm = await setupCaller(world, t, { role: { role: 'branch_manager' } });
      expect(
        (await t.http().patch('/v1/tenant/settings').set(bm.auth).send({ rev: 1, name: 'X' }))
          .status,
      ).toBe(403);
      const suspended = await setupCaller(world, t, { status: 'SUSPENDED' });
      const res = await t
        .http()
        .patch('/v1/tenant/settings')
        .set(suspended.auth)
        .send({ rev: 1, name: 'X' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('TENANT_SUSPENDED');
    });
  });
});
