import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogDetailSchema, AuditLogListResponseSchema } from '@venueos/shared';
import { createTestApp } from '../../../__tests__/helpers/create-test-app';
import type { TestApp } from '../../../__tests__/helpers/create-test-app';
import { authHeader } from '../../../__tests__/helpers/test-auth';
import { World } from '../../../__tests__/helpers/world';

describe('audit log endpoints', () => {
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

  /** A tenant with an Owner who can read the audit log. */
  async function setup() {
    const tenant = await world.createTenant({ plan: 'growth' });
    const owner = await world.addMember(tenant, { role: 'owner' });
    return { tenant, owner, auth: t.as(authHeader(owner.userId, tenant.id)) };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
  const list = async (ctx: Ctx, query = '') => {
    const res = await t.http().get(`/v1/audit-logs${query}`).set(ctx.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AuditLogListResponseSchema.parse(res.body);
  };

  /** The test probe writes one `probe.commit` row (after = `{ mode, password: '[REDACTED]' }`). */
  async function probe(ctx: Ctx, times = 1) {
    for (let i = 0; i < times; i += 1) {
      const res = await t.http().post('/v1/_access/audit/commit').set(ctx.auth);
      expect(res.status).toBe(201);
    }
  }

  describe('GET /v1/audit-logs', () => {
    it('200: newest first, with the actor name, no before/after in the list', async () => {
      const ctx = await setup();
      const role = await t
        .http()
        .post('/v1/roles')
        .set(ctx.auth)
        .send({ name: 'Front desk', copyFromRoleId: ctx.tenant.roles.sales_agent });
      expect(role.status).toBe(201);
      await probe(ctx);

      const page = await list(ctx);
      expect(page.data.map((r) => r.action)).toEqual(['probe.commit', 'role.create']);
      expect(page.nextCursor).toBeNull();
      expect(page.data[1]).toMatchObject({
        actorType: 'USER',
        actorUserId: ctx.owner.userId,
        actorName: 'Test User',
        entityType: 'role',
        entityId: role.body.id,
        venueId: null,
      });
      expect(page.data[0]).not.toHaveProperty('before');
      expect(page.data[0]).not.toHaveProperty('ip');
    });

    it('pages through everything with the cursor: nothing skipped, nothing repeated, even in the same millisecond', async () => {
      const ctx = await setup();
      await probe(ctx, 7);
      const all = (await list(ctx)).data.map((r) => r.id);
      expect(all).toHaveLength(7);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await list(ctx, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.data.map((r) => r.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(4);
      expect(seen).toEqual(all);
    });

    it('filters by entityType, entityId, actorUserId and action', async () => {
      const ctx = await setup();
      const other = await world.addMember(ctx.tenant, { role: 'owner' });
      const role = await t
        .http()
        .post('/v1/roles')
        .set(ctx.auth)
        .send({ name: 'Front desk', copyFromRoleId: ctx.tenant.roles.sales_agent });
      await t
        .http()
        .post('/v1/_access/audit/commit')
        .set(t.as(authHeader(other.userId, ctx.tenant.id)));
      await probe(ctx);

      expect((await list(ctx, '?entityType=role')).data.map((r) => r.action)).toEqual([
        'role.create',
      ]);
      expect((await list(ctx, `?entityId=${role.body.id}`)).data).toHaveLength(1);
      expect((await list(ctx, '?action=probe.commit')).data).toHaveLength(2);
      const byActor = await list(ctx, `?actorUserId=${other.userId}`);
      expect(byActor.data).toHaveLength(1);
      expect(byActor.data[0]?.actorUserId).toBe(other.userId);
      expect((await list(ctx, '?action=role.update')).data).toEqual([]);
    });

    it('from/to: a date-only value is a whole day of the workspace time zone; an instant is exact', async () => {
      const ctx = await setup(); // tenants of the fixtures use Asia/Karachi
      await probe(ctx);
      const day = (offset: number) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(
          new Date(Date.now() + offset * 24 * 3600 * 1000),
        );

      expect((await list(ctx, `?from=${day(0)}&to=${day(0)}`)).data).toHaveLength(1);
      expect((await list(ctx, `?from=${day(-3)}&to=${day(1)}`)).data).toHaveLength(1);
      expect((await list(ctx, `?to=${day(-1)}`)).data).toHaveLength(0);
      expect((await list(ctx, `?from=${day(1)}`)).data).toHaveLength(0);
      const now = Date.now();
      const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
      expect(
        (await list(ctx, `?from=${iso(now - 60_000)}&to=${iso(now + 60_000)}`)).data,
      ).toHaveLength(1);
      expect((await list(ctx, `?to=${iso(now - 60_000)}`)).data).toHaveLength(0);
    });

    it('400: bad limit, cursor, filters and dates', async () => {
      const ctx = await setup();
      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=abc',
        '?cursor=not-a-cursor',
        `?cursor=${Buffer.from('a1:missing_row', 'utf8').toString('base64url')}`,
        '?entityType=Bad%20Type',
        '?action=NOT%20AN%20ACTION',
        '?actorUserId=bad%20id',
        '?from=yesterday',
        '?from=2027-02-30',
        '?to=2027-13-01',
        '?from=2027-03-02&to=2027-03-01',
      ]) {
        const res = await t.http().get(`/v1/audit-logs${query}`).set(ctx.auth);
        expect(res.status, query).toBe(400);
        expect(code(res), query).toBe('VALIDATION_ERROR');
      }
    });

    it('401 without an identity, 403 without audit.view', async () => {
      const ctx = await setup();
      expect((await t.http().get('/v1/audit-logs')).status).toBe(401);
      const agent = await world.addMember(ctx.tenant, { role: 'sales_agent' });
      const res = await t
        .http()
        .get('/v1/audit-logs')
        .set(t.as(authHeader(agent.userId, ctx.tenant.id)));
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it("never shows another tenant's entries, whatever the filters or the cursor say", async () => {
      const a = await setup();
      const b = await setup();
      await probe(b, 2);
      const theirs = await list(b);
      expect(theirs.data).toHaveLength(2);

      expect((await list(a)).data).toEqual([]);
      expect((await list(a, `?entityId=${theirs.data[0]?.entityId}`)).data).toEqual([]);
      expect((await list(a, `?actorUserId=${b.owner.userId}`)).data).toEqual([]);
      // B's row id as a cursor is not a valid cursor for A.
      const cursor = Buffer.from(`a1:${theirs.data[0]?.id}`, 'utf8').toString('base64url');
      const res = await t.http().get(`/v1/audit-logs?cursor=${cursor}`).set(a.auth);
      expect(res.status).toBe(400);
    });

    it('works on a suspended workspace (read-only)', async () => {
      const tenant = await world.createTenant({ status: 'SUSPENDED' });
      const owner = await world.addMember(tenant, { role: 'owner' });
      const res = await t
        .http()
        .get('/v1/audit-logs')
        .set(t.as(authHeader(owner.userId, tenant.id)));
      expect(res.status).toBe(200);
    });
  });

  describe('GET /v1/audit-logs/:id', () => {
    it('200: the full entry, secrets masked as stored', async () => {
      const ctx = await setup();
      await probe(ctx);
      const [row] = (await list(ctx)).data;
      const res = await t.http().get(`/v1/audit-logs/${row?.id}`).set(ctx.auth);
      expect(res.status).toBe(200);
      const detail = AuditLogDetailSchema.parse(res.body);
      expect(detail).toMatchObject({
        id: row?.id,
        action: 'probe.commit',
        before: null,
        after: { mode: 'commit', password: '[REDACTED]' },
      });
      expect(detail.ip).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    });

    it('shows the before and after of a role edit', async () => {
      const ctx = await setup();
      const role = await t
        .http()
        .post('/v1/roles')
        .set(ctx.auth)
        .send({ name: 'Front desk', copyFromRoleId: ctx.tenant.roles.operations });
      await t
        .http()
        .patch(`/v1/roles/${role.body.id}`)
        .set(ctx.auth)
        .send({ rev: 1, permissions: ['booking.view'] });
      const [update] = (await list(ctx, '?action=role.update')).data;
      const detail = AuditLogDetailSchema.parse(
        (await t.http().get(`/v1/audit-logs/${update?.id}`).set(ctx.auth)).body,
      );
      expect((detail.before as { permissions: string[] }).permissions).toContain('inventory.view');
      expect((detail.after as { permissions: string[] }).permissions).toEqual(['booking.view']);
    });

    it('400: a malformed id; 401; 403; 404 for a missing id', async () => {
      const ctx = await setup();
      expect((await t.http().get('/v1/audit-logs/bad%20id').set(ctx.auth)).status).toBe(400);
      expect((await t.http().get('/v1/audit-logs/aud_1')).status).toBe(401);
      const agent = await world.addMember(ctx.tenant, { role: 'sales_agent' });
      const forbidden = await t
        .http()
        .get('/v1/audit-logs/aud_1')
        .set(t.as(authHeader(agent.userId, ctx.tenant.id)));
      expect(forbidden.status).toBe(403);
      expect((await t.http().get('/v1/audit-logs/aud_nope').set(ctx.auth)).status).toBe(404);
    });

    it("404: another tenant's entry looks the same as a missing one", async () => {
      const a = await setup();
      const b = await setup();
      await probe(b);
      const [row] = (await list(b)).data;
      const other = await t.http().get(`/v1/audit-logs/${row?.id}`).set(a.auth);
      const missing = await t.http().get('/v1/audit-logs/aud_nope').set(a.auth);
      expect(other.status).toBe(404);
      expect(other.body.error.message).toBe(missing.body.error.message);
    });
  });

  describe('venue scope', () => {
    it('a member limited to a venue sees only that venue, never tenant-wide entries', async () => {
      const ctx = await setup();
      const post = async (path: string, body: object) => {
        const res = await t.http().post(path).set(ctx.auth).send(body);
        expect(res.status, path).toBe(201);
        return res.body as { id: string };
      };
      const venueA = await post('/v1/venues', { name: 'Venue A' });
      const venueB = await post('/v1/venues', { name: 'Venue B' });
      const spaceA = await post('/v1/spaces', { venueId: venueA.id, name: 'Hall A' });
      const spaceB = await post('/v1/spaces', { venueId: venueB.id, name: 'Hall B' });
      const slotA = await post('/v1/slot-templates', {
        venueId: venueA.id,
        name: 'Lunch A',
        mode: 'FIXED',
        startTime: '12:00',
        endTime: '16:00',
      });
      await t
        .http()
        .patch(`/v1/slot-templates/${slotA.id}`)
        .set(ctx.auth)
        .send({ rev: 1, name: 'Lunch A2' });
      await t
        .http()
        .patch(`/v1/venues/${venueB.id}`)
        .set(ctx.auth)
        .send({ rev: 1, name: 'Venue B2' });
      await post('/v1/event-types', { name: 'Mehndi' }); // tenant-wide
      await probe(ctx); // tenant-wide

      // The Owner (all venues) sees everything, with the venue each row belongs to.
      const everything = (await list(ctx, '?limit=100')).data;
      expect(everything.find((r) => r.entityId === spaceB.id)?.venueId).toBe(venueB.id);
      expect(everything.find((r) => r.action === 'event_type.create')?.venueId).toBeNull();

      const scoped = await world.addMember(ctx.tenant, {
        role: { permissions: ['audit.view'] },
        venueIds: [venueA.id],
      });
      const scopedAuth = t.as(authHeader(scoped.userId, ctx.tenant.id));
      const mine = AuditLogListResponseSchema.parse(
        (await t.http().get('/v1/audit-logs?limit=100').set(scopedAuth)).body,
      );
      expect(mine.data.map((r) => r.action).sort()).toEqual([
        'slot_template.create',
        'slot_template.update',
        'space.create',
        'venue.create',
      ]);
      expect(mine.data.every((r) => r.venueId === venueA.id)).toBe(true);

      // Filters only narrow: asking for B's rows gives nothing.
      const asked = await t.http().get(`/v1/audit-logs?entityId=${spaceB.id}`).set(scopedAuth);
      expect(asked.status).toBe(200);
      expect(asked.body.data).toEqual([]);

      // The detail follows the same rule: out of scope and tenant-wide entries are 404.
      const inScope = mine.data.find((r) => r.entityId === spaceA.id);
      expect((await t.http().get(`/v1/audit-logs/${inScope?.id}`).set(scopedAuth)).status).toBe(
        200,
      );
      for (const hidden of [
        everything.find((r) => r.entityId === spaceB.id),
        everything.find((r) => r.action === 'event_type.create'),
      ]) {
        const res = await t.http().get(`/v1/audit-logs/${hidden?.id}`).set(scopedAuth);
        expect(res.status).toBe(404);
      }
      // A hidden row cannot be used as a cursor.
      const cursor = Buffer.from(`a1:${everything[0]?.id}`, 'utf8').toString('base64url');
      expect((await t.http().get(`/v1/audit-logs?cursor=${cursor}`).set(scopedAuth)).status).toBe(
        400,
      );
    });
  });
});
