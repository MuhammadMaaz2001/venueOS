import { describe, expect, it } from 'vitest';
import type { TestApp } from './create-test-app';
import { NO_VENUE_ACCESS, code, makeVenue, scopedManagerAuth, setupCaller } from './setup-fixtures';
import type { Caller } from './setup-fixtures';
import type { World } from './world';

// The access matrix every catalogue / pricing resource shares (CLAUDE.md rule 12): happy path, validation error,
// 401, 403 (no permission, and a caller limited to some venues for tenant-wide writes), another tenant's id = 404,
// `rev` conflicts, soft delete and the audit rows. Resource-specific rules live in the spec files themselves.

export interface CrudSpec {
  /** e.g. `/v1/menu-items` */
  path: string;
  /** A valid create body; `n` makes the unique parts (the name) different for each call. */
  create: (n: number) => Record<string, unknown>;
  /** A body Zod rejects. */
  invalid: Record<string, unknown>;
  /** A valid change (without `rev`) that shows up in the answer. */
  change: Record<string, unknown>;
  /** What `change` should look like in the answer. */
  changed: Record<string, unknown>;
  /** The audit actions and entity type. */
  audit: { create: string; update: string };
  /** Parses the answer (the shared Zod schema of the resource). */
  parse: (body: unknown) => unknown;
  /** Resources whose names must be unique among active rows: the field to clash on. */
  uniqueName?: string;
  /** Resources with a deactivation (`active: false`): all of them. */
  softDelete?: boolean;
  /** Role that may read but not write; default Sales agent (holds both view permissions, no manage). */
  readerRole?: Parameters<World['addMember']>[1];
}

let counter = 0;
export const nextN = (): number => ++counter;

export function crudMatrix(
  spec: CrudSpec,
  env: () => { t: TestApp; world: World },
  options: { tenantWide: boolean } = { tenantWide: true },
): void {
  const reader = spec.readerRole ?? { role: 'sales_agent' as const };
  const create = (auth: Record<string, string>, n = nextN()) =>
    env().t.http().post(spec.path).set(auth).send(spec.create(n));

  describe(`POST ${spec.path}`, () => {
    it('201: creates the record and writes an audit row; the same name in two tenants is fine', async () => {
      const { t, world } = env();
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const body = spec.create(nextN());
      const res = await t.http().post(spec.path).set(a.auth).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      spec.parse(res.body);
      expect(res.body).toMatchObject({ active: true, rev: 1 });
      const rows = await world.auditRows(a.tenant, {
        action: spec.audit.create,
        entityId: res.body.id,
      });
      expect(rows).toHaveLength(1);
      expect((await t.http().post(spec.path).set(b.auth).send(body)).status).toBe(201);
    });

    it('400: an invalid body', async () => {
      const { t, world } = env();
      const { auth } = await setupCaller(world, t);
      const res = await t.http().post(spec.path).set(auth).send(spec.invalid);
      expect(res.status).toBe(400);
      expect(code(res)).toBe('VALIDATION_ERROR');
    });

    it('401 without an identity; 403 without the manage permission', async () => {
      const { t, world } = env();
      const anonymous = await t
        .http()
        .post(spec.path)
        .set(t.csrfHeaders)
        .send(spec.create(nextN()));
      expect(anonymous.status).toBe(401);
      const agent = await setupCaller(world, t, { role: reader });
      const res = await create(agent.auth);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    if (options.tenantWide) {
      it('403: a caller limited to some venues cannot change tenant-wide data, but can read it', async () => {
        const { t, world } = env();
        const caller = await setupCaller(world, t);
        const venue = await makeVenue(t, caller.auth);
        const scoped = await scopedManagerAuth(world, t, caller.tenant, [venue.id]);
        expect((await create(scoped)).status).toBe(403);
        expect((await t.http().get(spec.path).set(scoped)).status).toBe(200);
      });
    }

    if (spec.uniqueName) {
      it('409: the same name twice among active rows, ignoring case', async () => {
        const { t, world } = env();
        const { auth } = await setupCaller(world, t);
        const body = spec.create(nextN());
        expect((await t.http().post(spec.path).set(auth).send(body)).status).toBe(201);
        const name = String(body[spec.uniqueName as string]);
        const dup = await t
          .http()
          .post(spec.path)
          .set(auth)
          .send({ ...body, [spec.uniqueName as string]: name.toUpperCase() });
        expect(dup.status).toBe(409);
        expect(code(dup)).toBe('DUPLICATE');
      });
    }
  });

  describe(`GET ${spec.path}`, () => {
    it('200: lists the tenant only, hides inactive rows unless asked, reads one', async () => {
      const { t, world } = env();
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const mine = (await create(a.auth)).body;
      const old = (await create(a.auth)).body;
      await create(b.auth);
      if (spec.softDelete) {
        const gone = await t
          .http()
          .patch(`${spec.path}/${old.id}`)
          .set(a.auth)
          .send({ rev: old.rev, active: false });
        expect(gone.status, JSON.stringify(gone.body)).toBe(200);
        expect(gone.body.active).toBe(false);
      }
      const list = await t.http().get(spec.path).set(a.auth);
      expect(list.status).toBe(200);
      expect(list.body.nextCursor).toBeNull();
      const ids = list.body.data.map((r: { id: string }) => r.id);
      expect(ids).toContain(mine.id);
      if (spec.softDelete) expect(ids).not.toContain(old.id);
      const all = await t.http().get(`${spec.path}?includeInactive=true`).set(a.auth);
      expect(all.body.data.map((r: { id: string }) => r.id)).toEqual(
        expect.arrayContaining([mine.id, old.id]),
      );
      // Nothing of the other tenant, in any answer.
      expect(all.body.data).toHaveLength(2);
      expect((await t.http().get(`${spec.path}/${mine.id}`).set(a.auth)).status).toBe(200);
    });

    it('404 for another tenant; 401; 403 without the view permission', async () => {
      const { t, world } = env();
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const mine = (await create(a.auth)).body;
      expect((await t.http().get(`${spec.path}/${mine.id}`).set(b.auth)).status).toBe(404);
      expect((await t.http().get(spec.path)).status).toBe(401);
      const none = await setupCaller(world, t, NO_VENUE_ACCESS);
      expect((await t.http().get(spec.path).set(none.auth)).status).toBe(403);
      expect((await t.http().get(`${spec.path}/${mine.id}`).set(none.auth)).status).toBe(403);
      const ok = await setupCaller(world, t, { role: reader });
      expect((await t.http().get(spec.path).set(ok.auth)).status).toBe(200);
      // A malformed id never reaches the database.
      expect((await t.http().get(`${spec.path}/not%20an%20id`).set(a.auth)).status).toBe(400);
    });
  });

  describe(`PATCH ${spec.path}/:id`, () => {
    it('200: applies the change, bumps rev, audits before and after', async () => {
      const { t, world } = env();
      const { auth, tenant } = await setupCaller(world, t);
      const row = (await create(auth)).body;
      const res = await t
        .http()
        .patch(`${spec.path}/${row.id}`)
        .set(auth)
        .send({ rev: row.rev, ...spec.change });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ ...spec.changed, rev: row.rev + 1 });
      spec.parse(res.body);
      const rows = await world.auditRows(tenant, { action: spec.audit.update, entityId: row.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toBeTruthy();
      expect(rows[0]?.after).toBeTruthy();
    });

    it('409 for a stale rev; 400 for nothing to change or a bad body', async () => {
      const { t, world } = env();
      const { auth } = await setupCaller(world, t);
      const row = (await create(auth)).body;
      const path = `${spec.path}/${row.id}`;
      expect(
        (
          await t
            .http()
            .patch(path)
            .set(auth)
            .send({ rev: row.rev, ...spec.change })
        ).status,
      ).toBe(200);
      const stale = await t
        .http()
        .patch(path)
        .set(auth)
        .send({ rev: row.rev, ...spec.change });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('VERSION_CONFLICT');
      expect(
        (
          await t
            .http()
            .patch(path)
            .set(auth)
            .send({ rev: row.rev + 1 })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .patch(path)
            .set(auth)
            .send({ ...spec.change })
        ).status,
      ).toBe(400);
    });

    it('401, 403 without the manage permission, 404 for another tenant', async () => {
      const { t, world } = env();
      const a = await setupCaller(world, t);
      const b = await setupCaller(world, t);
      const row = (await create(a.auth)).body;
      const path = `${spec.path}/${row.id}`;
      const body = { rev: row.rev, ...spec.change };
      expect((await t.http().patch(path).set(t.csrfHeaders).send(body)).status).toBe(401);
      const agent = await setupCaller(world, t, { role: reader });
      expect((await t.http().patch(path).set(agent.auth).send(body)).status).toBe(403);
      expect((await t.http().patch(path).set(b.auth).send(body)).status).toBe(404);
      // And the row is untouched.
      expect((await t.http().get(path).set(a.auth)).body.rev).toBe(row.rev);
    });

    if (options.tenantWide) {
      it('403: a caller limited to some venues cannot change it', async () => {
        const { t, world } = env();
        const caller: Caller = await setupCaller(world, t);
        const row = (await create(caller.auth)).body;
        const venue = await makeVenue(t, caller.auth);
        const scoped = await scopedManagerAuth(world, t, caller.tenant, [venue.id]);
        const res = await t
          .http()
          .patch(`${spec.path}/${row.id}`)
          .set(scoped)
          .send({ rev: row.rev, ...spec.change });
        expect(res.status).toBe(403);
      });
    }

    if (spec.softDelete) {
      it('active: false deactivates and active: true brings it back', async () => {
        const { t, world } = env();
        const { auth } = await setupCaller(world, t);
        const row = (await create(auth)).body;
        const path = `${spec.path}/${row.id}`;
        const off = await t.http().patch(path).set(auth).send({ rev: row.rev, active: false });
        expect(off.body.active).toBe(false);
        const on = await t.http().patch(path).set(auth).send({ rev: off.body.rev, active: true });
        expect(on.status).toBe(200);
        expect(on.body.active).toBe(true);
      });
    }

    if (spec.uniqueName) {
      it('409: renaming onto a taken name, or reactivating a name that was taken meanwhile', async () => {
        const { t, world } = env();
        const { auth } = await setupCaller(world, t);
        const one = (await create(auth)).body;
        const two = (await create(auth)).body;
        const field = spec.uniqueName as string;
        const rename = await t
          .http()
          .patch(`${spec.path}/${two.id}`)
          .set(auth)
          .send({ rev: two.rev, [field]: one[field] });
        expect(rename.status).toBe(409);
        // Deactivate `one`, create another with its name, then try to reactivate `one`.
        const off = await t
          .http()
          .patch(`${spec.path}/${one.id}`)
          .set(auth)
          .send({ rev: one.rev, active: false });
        expect(off.status).toBe(200);
        const again = await t
          .http()
          .post(spec.path)
          .set(auth)
          .send({ ...spec.create(nextN()), [field]: one[field] });
        expect(again.status).toBe(201);
        const back = await t
          .http()
          .patch(`${spec.path}/${one.id}`)
          .set(auth)
          .send({ rev: off.body.rev, active: true });
        expect(back.status).toBe(409);
      });
    }
  });
}
