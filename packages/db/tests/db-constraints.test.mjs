// DB constraint + RLS + privilege tests, run against the REAL schema (not hand-written tables).
//
//   pnpm --filter @venueos/db test:constraints        (script defined in P0-1/P0-2: node --test tests/)
//
// Needs a Postgres 16 cluster that already ran packages/db/docker/init-roles.sql (roles) and a
// superuser URL to create a throwaway database:
//   docker compose up -d postgres
//   VENUEOS_TEST_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres   (default)
// Role passwords default to the local placeholders in init-roles.sql; override with
//   VENUEOS_TEST_MIGRATOR_PASSWORD / _APP_PASSWORD / _AUTH_PASSWORD / _JOBS_PASSWORD.
//
// What it does: CREATE DATABASE (owned by venueos_migrator) -> build the schema as the
// NON-superuser migrator -> run the checks as venueos_app / venueos_auth / venueos_jobs -> DROP.
//
// Schema source: once P0-2 has created prisma/migrations/*, those migration.sql files are applied
// in order (exactly what `prisma migrate deploy` does). Until then the DDL is generated with
// `prisma migrate diff --from-empty --to-schema` and 001_constraints_and_rls.sql is appended,
// which is what the first migration will contain (the Prisma 7 CLI needs prisma.config.ts in the
// package, added in P0-1). PRISMA_CMD overrides how prisma is invoked (default `pnpm exec prisma`),
// PRISMA_CWD where it runs (default: this package). Run with Node's built-in runner:
//   node --test "tests/*.test.mjs"        (quote the glob; Node 24 does not accept a bare directory)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase, urlFor } from './helpers/test-db.mjs';

let dbName;

let admin, migrator, app, auth, jobs;

const connect = async (user) => {
  const c = new pg.Client({ connectionString: urlFor(user, dbName) });
  await c.connect();
  return c;
};

// Run `fn(client)` in a transaction with the given app.* context, like TenantDb does.
async function ctx(client, { tenant, user } = {}, fn) {
  await client.query('BEGIN');
  try {
    if (tenant) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    if (user) await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
const sql = (client, c, text, params) => ctx(client, c, (cl) => cl.query(text, params));
const rejects = (promise, re) => assert.rejects(promise, (e) => re.test(e.message), `expected error matching ${re}`);

before(async () => {
  ({ admin, dbName } = await createTestDatabase());
  migrator = await connect('venueos_migrator');

  app = await connect('venueos_app');
  auth = await connect('venueos_auth');
  jobs = await connect('venueos_jobs');

  // Fixtures. Users/credentials go through the auth role; tenant data through the app role
  // with the tenant context set (signup pattern: pre-generated tenant id, set app.tenant_id, insert).
  await sql(auth, {}, `INSERT INTO users (id, name, email) VALUES ('u1','User One','u1@example.test'),('u2','User Two','u2@example.test')`);
  await sql(app, { tenant: 't1' }, `
    INSERT INTO tenants (id, slug, name, country, currency, timezone, status, custom_domain)
      VALUES ('t1','royal','Royal','PK','PKR','Asia/Karachi','ACTIVE','royal.example.test');
    INSERT INTO roles (id, tenant_id, name, permissions) VALUES ('r1','t1','Owner','{}');
    INSERT INTO memberships (id, tenant_id, user_id, role_id, venue_ids) VALUES ('m1','t1','u1','r1','{}');
    INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v1','t1','Royal Hall','{}'),('v1b','t1','Royal Lawn','{}');
    INSERT INTO spaces (id, tenant_id, venue_id, name) VALUES ('hallA','t1','v1','Hall A'),('hallB','t1','v1','Hall B'),('lawnZ','t1','v1b','Lawn Z');
    INSERT INTO spaces (id, tenant_id, venue_id, name, is_combined) VALUES ('hallAB','t1','v1','Hall A+B',true),('hallABC','t1','v1','Hall A+B+C',true);
    INSERT INTO customers (id, tenant_id, name, phone) VALUES ('c1','t1','Ali','+923001234567');`);
  await sql(app, { tenant: 't2' }, `
    INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
      VALUES ('t2','grand','Grand','PK','PKR','Asia/Karachi','ACTIVE');
    INSERT INTO roles (id, tenant_id, name, permissions) VALUES ('r2','t2','Owner','{}');
    INSERT INTO memberships (id, tenant_id, user_id, role_id, venue_ids) VALUES ('m2','t2','u1','r2','{}'),('m3','t2','u2','r2','{}');
    INSERT INTO venues (id, tenant_id, name, photo_keys) VALUES ('v2','t2','Grand Hall','{}');
    INSERT INTO spaces (id, tenant_id, venue_id, name) VALUES ('g1','t2','v2','Grand Hall');
    INSERT INTO customers (id, tenant_id, name, phone) VALUES ('c2','t2','Sara','+923009999999');
    INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency) VALUES ('bk2','t2','v2','c2','PKR');
    INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
      VALUES ('sess2','t2','bk2','g1','2027-02-14 19:00+05','2027-02-14 23:00+05',100);`);
  await sql(app, { tenant: 't3' }, `
    INSERT INTO tenants (id, slug, name, country, currency, timezone, status)
      VALUES ('t3','old','Old','PK','PKR','Asia/Karachi','SUSPENDED');`);
});

after(async () => {
  for (const c of [app, auth, jobs, migrator]) await c?.end().catch(() => {});
  await dropTestDatabase(admin, dbName);
});

// ───────────────────────────── roles ─────────────────────────────

test('roles: migrator is not a superuser; app/auth have no BYPASSRLS; definer and jobs do', async () => {
  const { rows } = await admin.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'venueos_%'`);
  const r = Object.fromEntries(rows.map((x) => [x.rolname, x]));
  assert.equal(r.venueos_migrator.rolsuper, false);
  assert.equal(r.venueos_migrator.rolbypassrls, false);
  assert.equal(r.venueos_app.rolbypassrls, false);
  assert.equal(r.venueos_auth.rolbypassrls, false);
  assert.equal(r.venueos_definer.rolbypassrls, true);
  assert.equal(r.venueos_definer.rolcanlogin, false);
  assert.equal(r.venueos_jobs.rolbypassrls, true);
});

// ───────────────────────────── RLS ─────────────────────────────

test('RLS: every tenant_id table has forced RLS and the tenant_isolation policy', async () => {
  const q = `
    SELECT c.table_name FROM information_schema.columns c
      JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND NOT (k.relrowsecurity AND k.relforcerowsecurity
                AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.table_name AND p.policyname = 'tenant_isolation'))`;
  const missing = await migrator.query(q);
  assert.deepEqual(missing.rows.map((r) => r.table_name), []);
});

test('RLS: tenants and users have forced RLS too', async () => {
  const { rows } = await migrator.query(
    `SELECT relname FROM pg_class WHERE relname IN ('tenants','users') AND NOT (relrowsecurity AND relforcerowsecurity)`);
  assert.deepEqual(rows, []);
});

test('RLS: a tenant sees only its own rows; writing another tenant row is rejected', async () => {
  assert.equal((await sql(app, { tenant: 't1' }, 'SELECT id FROM spaces')).rowCount, 5);
  assert.equal((await sql(app, { tenant: 't2' }, 'SELECT id FROM spaces')).rowCount, 1);
  await rejects(
    sql(app, { tenant: 't1' }, `INSERT INTO spaces (id, tenant_id, venue_id, name) VALUES ('x','t2','v2','x')`),
    /row-level security/);
});

test('RLS: no tenant context -> no rows', async () => {
  assert.equal((await app.query('SELECT * FROM spaces')).rowCount, 0);
  assert.equal((await app.query('SELECT * FROM tenants')).rowCount, 0);
  assert.equal((await app.query('SELECT * FROM users')).rowCount, 0);
});

test('RLS: before a tenant is chosen, a user sees only their own memberships and tenants', async () => {
  assert.equal((await sql(app, { user: 'u1' }, 'SELECT * FROM memberships')).rowCount, 2);
  const t = await sql(app, { user: 'u2' }, 'SELECT id FROM tenants');
  assert.deepEqual(t.rows.map((r) => r.id), ['t2']);
});

test('RLS: users visible = yourself + members of the current tenant (auth role sees all)', async () => {
  const noTenant = await sql(app, { user: 'u1' }, 'SELECT id FROM users');
  assert.deepEqual(noTenant.rows.map((r) => r.id), ['u1']);
  const t1 = await sql(app, { user: 'u1', tenant: 't1' }, 'SELECT id FROM users ORDER BY id');
  assert.deepEqual(t1.rows.map((r) => r.id), ['u1']);
  const t2 = await sql(app, { user: 'u1', tenant: 't2' }, 'SELECT id FROM users ORDER BY id');
  assert.deepEqual(t2.rows.map((r) => r.id), ['u1', 'u2']);
  assert.equal((await auth.query('SELECT id FROM users')).rowCount, 2);
  await rejects(sql(app, { user: 'u1' }, `INSERT INTO users (id, name) VALUES ('u3','Mallory')`), /row-level security/);
});

test('resolve_tenant works under FORCE RLS, is owned by venueos_definer and ignores suspended tenants', async () => {
  assert.equal((await app.query("SELECT resolve_tenant('royal') AS id")).rows[0].id, 't1');
  assert.equal((await app.query("SELECT resolve_tenant('royal.example.test') AS id")).rows[0].id, 't1');
  assert.equal((await app.query("SELECT resolve_tenant('old') AS id")).rows[0].id, null);
  assert.equal((await app.query("SELECT resolve_tenant('nope') AS id")).rows[0].id, null);
  const o = await migrator.query(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE proname = 'resolve_tenant'`);
  assert.equal(o.rows[0].owner, 'venueos_definer');
  await rejects(jobs.query("SELECT resolve_tenant('royal')"), /permission denied/); // jobs role has no EXECUTE
});

// ───────────────────────────── rev / updated_at ─────────────────────────────

test('rev + updated_at: every table with a rev column has the touch_row trigger and it bumps', async () => {
  const { rows } = await migrator.query(`
    SELECT c.table_name FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.column_name = 'rev'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = format('public.%I', c.table_name)::regclass AND g.tgname = 'touch_row')`);
  assert.deepEqual(rows.map((r) => r.table_name), []);
  const before = (await sql(app, { tenant: 't1' }, `SELECT rev, updated_at FROM customers WHERE id = 'c1'`)).rows[0];
  await sql(app, { tenant: 't1' }, `UPDATE customers SET notes = 'vip' WHERE id = 'c1'`);
  const after = (await sql(app, { tenant: 't1' }, `SELECT rev, updated_at FROM customers WHERE id = 'c1'`)).rows[0];
  assert.equal(after.rev, before.rev + 1);
  assert.ok(after.updated_at >= before.updated_at);
});

// ───────────────────────────── double booking ─────────────────────────────

const T1 = { tenant: 't1' };
const dinner = ['2027-02-14 18:00+05', '2027-02-15 00:00+05'];

test('bookings: number is required once a booking is held, not for drafts', async () => {
  await sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency) VALUES ('b1','t1','v1','c1','PKR')`);
  await rejects(sql(app, T1, `UPDATE bookings SET status = 'TENTATIVE' WHERE id = 'b1'`), /bookings_number_required/);
});

test('occupancy.active is derived: a DRAFT booking never blocks, even if the app writes active=true', async () => {
  await sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                      VALUES ('s1','t1','b1','hallA',$1,$2,300)`, dinner);
  await sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at, active)
                      VALUES ('o1','t1','s1','hallA',$1,$2,true)`, dinner);
  assert.equal((await sql(app, T1, `SELECT active FROM space_occupancies WHERE id='o1'`)).rows[0].active, false);
});

test('holding a booking activates its occupancy; overlapping dinner on the same hall is rejected', async () => {
  await sql(app, T1, `UPDATE bookings SET status = 'TENTATIVE', number = 'RB-2027-0001' WHERE id = 'b1'`);
  assert.equal((await sql(app, T1, `SELECT active FROM space_occupancies WHERE id='o1'`)).rows[0].active, true);

  await sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency, status, number)
                      VALUES ('b2','t1','v1','c1','PKR','TENTATIVE','RB-2027-0002')`);
  await sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                      VALUES ('s2','t1','b2','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05',200)`);
  await rejects(sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o2','t1','s2','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05')`),
    /space_occupancies_no_overlap/);
});

test('back-to-back ranges and different halls are allowed; invalid range is rejected', async () => {
  await sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o3','t1','s2','hallA','2027-02-14 12:00+05','2027-02-14 18:00+05')`); // ends when dinner starts
  await sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o4','t1','s2','hallB','2027-02-14 19:00+05','2027-02-14 23:30+05')`);
  await rejects(sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o5','t1','s2','hallA','2027-03-01 20:00+05','2027-03-01 19:00+05')`), /valid_range/);
});

test('a combined hall booking writes one row per component and is blocked by either component', async () => {
  await sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency, status, number)
                      VALUES ('b3','t1','v1','c1','PKR','TENTATIVE','RB-2027-0003')`);
  await sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                      VALUES ('s3','t1','b3','hallAB','2027-02-14 20:00+05','2027-02-14 23:00+05',400)`);
  await rejects(sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at) VALUES
        ('o6','t1','s3','hallA','2027-02-20 19:00+05','2027-02-20 23:00+05'),
        ('o7','t1','s3','hallB','2027-02-14 20:00+05','2027-02-14 23:00+05')`), /no_overlap/);
});

test('cancelling releases the slot; re-confirming fails while someone else holds it', async () => {
  await sql(app, T1, `UPDATE bookings SET status = 'CANCELLED' WHERE id = 'b1'`);
  assert.equal((await sql(app, T1, `SELECT active FROM space_occupancies WHERE id='o1'`)).rows[0].active, false);
  await sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o8','t1','s2','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05')`);
  await rejects(sql(app, T1, `UPDATE bookings SET status = 'CONFIRMED' WHERE id = 'b1'`), /no_overlap/);
});

test('draft -> hold fails with the exclusion error when the slot was taken meanwhile', async () => {
  await sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency) VALUES ('b4','t1','v1','c1','PKR')`);
  await sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                      VALUES ('s4','t1','b4','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05',150)`);
  await sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                      VALUES ('o9','t1','s4','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05')`); // draft: inactive, allowed
  await rejects(sql(app, T1, `UPDATE bookings SET status = 'TENTATIVE', number = 'RB-2027-0004' WHERE id = 'b4'`), /no_overlap/);
});

test('soft-cancelling one session frees only that session; restoring re-blocks', async () => {
  await sql(app, T1, `UPDATE booking_sessions SET status = 'CANCELLED', cancelled_at = now() WHERE id = 's2'`);
  const rows = (await sql(app, T1, `SELECT id, active FROM space_occupancies WHERE session_id = 's2' ORDER BY id`)).rows;
  assert.ok(rows.length >= 2 && rows.every((r) => r.active === false));
  await sql(app, T1, `UPDATE booking_sessions SET status = 'ACTIVE', cancelled_at = NULL WHERE id = 's2'`);
  const again = (await sql(app, T1, `SELECT active FROM space_occupancies WHERE session_id = 's2'`)).rows;
  assert.ok(again.every((r) => r.active === true));
});

test('app role cannot DELETE bookings or booking sessions', async () => {
  await rejects(sql(app, T1, `DELETE FROM bookings WHERE id = 'b4'`), /permission denied/);
  await rejects(sql(app, T1, `DELETE FROM booking_sessions WHERE id = 's4'`), /permission denied/);
});

// ───────────────────────────── cross-tenant references ─────────────────────────────

test('composite FKs: another tenant\'s customer / booking / space / session cannot be referenced', async () => {
  await rejects(sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency) VALUES ('bx','t1','v1','c2','PKR')`), /foreign key/);
  await rejects(sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                              VALUES ('sx','t1','bk2','hallA','2027-05-01 10:00+05','2027-05-01 12:00+05',10)`), /foreign key/);
  await rejects(sql(app, T1, `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests)
                              VALUES ('sy','t1','b4','g1','2027-05-01 10:00+05','2027-05-01 12:00+05',10)`), /foreign key/);
  await rejects(sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                              VALUES ('oz','t1','sess2','hallB','2027-05-01 10:00+05','2027-05-01 12:00+05')`), /foreign key/);
  await rejects(sql(app, T1, `INSERT INTO space_occupancies (id, tenant_id, session_id, space_id, starts_at, ends_at)
                              VALUES ('oy','t1','s4','g1','2027-05-01 10:00+05','2027-05-01 12:00+05')`), /foreign key/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount) VALUES ('px','t1','bk2','CASH',10)`), /foreign key/);
});

// ───────────────────────────── combined spaces ─────────────────────────────

test('combined spaces: components must be physical spaces of the same venue; no nesting', async () => {
  await sql(app, T1, `INSERT INTO space_components (tenant_id, combined_space_id, component_space_id)
                      VALUES ('t1','hallAB','hallA'),('t1','hallAB','hallB')`);
  await rejects(sql(app, T1, `INSERT INTO space_components (tenant_id, combined_space_id, component_space_id) VALUES ('t1','hallABC','hallAB')`), /space_components_no_nesting/);
  await rejects(sql(app, T1, `INSERT INTO space_components (tenant_id, combined_space_id, component_space_id) VALUES ('t1','hallA','hallB')`), /parent_not_combined/);
  await rejects(sql(app, T1, `INSERT INTO space_components (tenant_id, combined_space_id, component_space_id) VALUES ('t1','hallABC','lawnZ')`), /same_venue/);
  await rejects(sql(app, T1, `UPDATE spaces SET is_combined = true WHERE id = 'hallA'`), /space_components_no_nesting/);
  await rejects(sql(app, T1, `UPDATE spaces SET is_combined = false WHERE id = 'hallAB'`), /parent_not_combined/);
});

// ───────────────────────────── auth tables ─────────────────────────────

test('auth-only tables: venueos_app has no access, venueos_auth does', async () => {
  for (const t of ['user_credentials', 'auth_sessions', 'auth_tokens', 'invitations', 'login_attempts']) {
    await rejects(sql(app, T1, `SELECT * FROM ${t}`), /permission denied/);
  }
  await sql(auth, {}, `INSERT INTO user_credentials (user_id, password_hash) VALUES ('u1','$argon2id$test')`);
  await sql(auth, {}, `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('as1','u1','hash1', now() + interval '1 day')`);
  await sql(auth, {}, `INSERT INTO login_attempts (id, email_hash, ip) VALUES ('la1','h','127.0.0.1')`);
  await sql(auth, {}, `INSERT INTO invitations (id, tenant_id, email, role_id, venue_ids, token_hash, expires_at)
                       VALUES ('inv1','t1','new@example.test','r1','{}','invhash', now() + interval '72 hours')`);
  // accepting an invite looks the row up by token before any tenant context exists
  const r = await sql(auth, {}, `SELECT tenant_id FROM invitations WHERE token_hash = 'invhash'`);
  assert.equal(r.rows[0].tenant_id, 't1');
});

// ───────────────────────────── append-only ─────────────────────────────

test('append-only: payments allow INSERT, and UPDATE only of status/cleared_at; never DELETE', async () => {
  await sql(app, T1, `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency, status, number)
                      VALUES ('b5','t1','v1','c1','PKR','CONFIRMED','RB-2027-0005')`);
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status, idempotency_key)
                      VALUES ('p1','t1','b5','CHEQUE',50000.5,'PENDING','key-1')`);
  await sql(app, T1, `UPDATE payments SET status = 'CLEARED', cleared_at = now() WHERE id = 'p1'`);
  await rejects(sql(app, T1, `UPDATE payments SET amount = 1 WHERE id = 'p1'`), /permission denied/);
  await rejects(sql(app, T1, `UPDATE payments SET booking_id = 'b1' WHERE id = 'p1'`), /permission denied/);
  await rejects(sql(app, T1, `DELETE FROM payments WHERE id = 'p1'`), /permission denied/);
});

test('append-only: expenses, inventory_movements, audit_logs, message_logs', async () => {
  await sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method) VALUES ('e1','t1','DECOR','Flowers',1200,'CASH')`);
  await sql(app, T1, `INSERT INTO inventory_items (id, tenant_id, name, category, on_hand) VALUES ('i1','t1','Plate','crockery',100)`);
  await sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta) VALUES ('im0','t1','i1','PURCHASE',100)`);
  await sql(app, T1, `INSERT INTO audit_logs (id, tenant_id, actor_type, actor_user_id, action, entity_type, entity_id) VALUES ('a1','t1','USER','u1','booking.hold','booking','b1')`);
  await sql(app, T1, `INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type, entity_id) VALUES ('a2','t1','SYSTEM','booking.expire','booking','b1')`);
  await sql(app, T1, `INSERT INTO message_logs (id, tenant_id, message_key, channel, "to", status) VALUES ('ml1','t1','mk1','email','a@example.test','queued')`);
  for (const [t, set, id] of [
    ['expenses', 'amount = 1', 'e1'], ['inventory_movements', 'stock_delta = 1', 'im0'],
    ['audit_logs', "action = 'x'", 'a1'], ['message_logs', "status = 'sent'", 'ml1'],
  ]) {
    await rejects(sql(app, T1, `UPDATE ${t} SET ${set} WHERE id = '${id}'`), /permission denied/);
    await rejects(sql(app, T1, `DELETE FROM ${t} WHERE id = '${id}'`), /permission denied/);
  }
});

test('plans are read-only for the app role', async () => {
  await rejects(app.query(`INSERT INTO plans (id, code, name, entitlements, price_monthly, currency) VALUES ('pl','x','x','{}',1,'PKR')`), /permission denied/);
});

// ───────────────────────────── payments / expenses rules ─────────────────────────────

test('payments: positive amount, reversal link, one reversal per entry, refund link', async () => {
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount) VALUES ('p0','t1','b5','CASH',0)`), /payments_amount_positive/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type) VALUES ('p0','t1','b5','CASH',10,'REVERSAL')`), /payments_reversal_link/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, reverses_id) VALUES ('p0','t1','b5','CASH',10,'p1')`), /payments_reversal_link/);
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, reverses_id, notes)
                      VALUES ('p2','t1','b5','CHEQUE',50000.5,'REVERSAL','p1','wrong booking')`);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, reverses_id)
                      VALUES ('p3','t1','b5','CHEQUE',50000.5,'REVERSAL','p1')`), /payments_reverses_id_key/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, refund_request_id) VALUES ('p4','t1','b5','CASH',5,'rr-none')`), /payments_refund_link|foreign key/);
});

test('payment status: only CHEQUE may be PENDING/BOUNCED; other methods are CLEARED on entry', async () => {
  for (const method of ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'ONLINE_GATEWAY']) {
    await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status) VALUES ('ps','t1','b5','${method}',5,'PENDING')`), /payments_status_by_method/);
    await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status) VALUES ('ps','t1','b5','${method}',5,'BOUNCED')`), /payments_status_by_method/);
    await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount) VALUES ('ps-${method}','t1','b5','${method}',5)`); // default CLEARED
  }
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status) VALUES ('ps-chq','t1','b5','CHEQUE',5,'PENDING')`);
  await sql(app, T1, `UPDATE payments SET status = 'BOUNCED' WHERE id = 'ps-chq'`);
  await rejects(sql(app, T1, `UPDATE payments SET status = 'PENDING' WHERE id = 'ps-CASH'`), /payments_status_by_method/); // cannot "reopen" a cash payment
  const def = await sql(app, T1, `SELECT status FROM payments WHERE id = 'ps-CASH'`);
  assert.equal(def.rows[0].status, 'CLEARED');
});

test('line items are signed: DISCOUNT <= 0, ADJUSTMENT +/-, everything else >= 0; total = SUM(amount)', async () => {
  const ins = (id, kind, amount) => sql(app, T1, `INSERT INTO booking_line_items (id, tenant_id, booking_id, kind, description, unit_price, amount)
                                                  VALUES ('${id}','t1','b5','${kind}','x',${amount},${amount})`);
  await ins('li1', 'RENT', 100000);
  await ins('li2', 'PACKAGE', 250000.5);
  await ins('li3', 'ADD_ON', 0);
  await ins('li4', 'ADJUSTMENT', 20000);   // price rule +
  await ins('li5', 'ADJUSTMENT', -5000);   // price rule −
  await ins('li6', 'DISCOUNT', -10000);
  await ins('li7', 'DISCOUNT', 0);
  await ins('li8', 'TAX', 35550);
  await rejects(ins('lx1', 'DISCOUNT', 10000), /booking_line_items_amount_sign/);
  for (const kind of ['RENT', 'PACKAGE', 'ADD_ON', 'TAX']) {
    await rejects(ins('lx2', kind, -1), /booking_line_items_amount_sign/);
  }
  const total = await sql(app, T1, `SELECT SUM(amount) AS total FROM booking_line_items WHERE booking_id = 'b5'`);
  assert.equal(Number(total.rows[0].total), 100000 + 250000.5 + 0 + 20000 - 5000 - 10000 + 0 + 35550);
});

test('refunds: request + approval creates the REFUND payment linked to it', async () => {
  await sql(app, T1, `INSERT INTO refund_requests (id, tenant_id, booking_id, amount, reason, requested_by_id)
                      VALUES ('rr1','t1','b5',1000,'cancelled','u1')`);
  await rejects(sql(app, T1, `INSERT INTO refund_requests (id, tenant_id, booking_id, amount, reason, requested_by_id) VALUES ('rr0','t1','b5',0,'x','u1')`), /refund_requests_amount_positive/);
  await sql(app, T1, `UPDATE refund_requests SET status = 'APPROVED', approved_by_id = 'u1', self_approved = true, decided_at = now() WHERE id = 'rr1'`);
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, refund_request_id)
                      VALUES ('p5','t1','b5','CASH',1000,'REFUND','rr1')`);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, refund_request_id)
                      VALUES ('p6','t1','b5','CASH',1000,'REFUND','rr1')`), /refund_request_id_key/);
  await rejects(sql(app, T1, `DELETE FROM refund_requests WHERE id = 'rr1'`), /permission denied/);
});

test('idempotency keys are unique per tenant (payments, refund_requests, expenses, inventory_movements)', async () => {
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, idempotency_key) VALUES ('p7','t1','b5','CASH',5,'key-1')`), /idempotency_key/);
  await sql(app, { tenant: 't2' }, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, idempotency_key) VALUES ('p8','t2','bk2','CASH',5,'key-1')`); // other tenant: fine
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount) VALUES ('p9','t1','b5','CASH',5),('p10','t1','b5','CASH',5)`); // NULL keys never collide
  await sql(app, T1, `INSERT INTO refund_requests (id, tenant_id, booking_id, amount, reason, requested_by_id, idempotency_key) VALUES ('rr2','t1','b5',5,'x','u1','rk')`);
  await rejects(sql(app, T1, `INSERT INTO refund_requests (id, tenant_id, booking_id, amount, reason, requested_by_id, idempotency_key) VALUES ('rr3','t1','b5',5,'x','u1','rk')`), /idempotency_key/);
  await sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method, idempotency_key) VALUES ('e2','t1','OTHER','x',5,'CASH','ek')`);
  await rejects(sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method, idempotency_key) VALUES ('e3','t1','OTHER','x',5,'CASH','ek')`), /idempotency_key/);
  await sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, idempotency_key) VALUES ('im1','t1','i1','ADJUSTMENT',-1,'mk')`);
  await rejects(sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, idempotency_key) VALUES ('im2','t1','i1','ADJUSTMENT',-1,'mk')`), /idempotency_key/);
});

test('expenses: amount > 0, reversals must link to the expense they negate', async () => {
  await rejects(sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method) VALUES ('e4','t1','OTHER','x',0,'CASH')`), /expenses_amount_positive/);
  await rejects(sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method, entry_type) VALUES ('e4','t1','OTHER','x',5,'CASH','REVERSAL')`), /expenses_reversal_link/);
  await sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method, entry_type, reverses_id) VALUES ('e5','t1','DECOR','reverse flowers',1200,'CASH','REVERSAL','e1')`);
  await rejects(sql(app, T1, `INSERT INTO expenses (id, tenant_id, category, description, amount, method, entry_type, reverses_id) VALUES ('e6','t1','DECOR','again',1200,'CASH','REVERSAL','e1')`), /expenses_reverses_id_key/);
});

// ───────────────────────────── inventory ─────────────────────────────

test('inventory: on_hand never negative; movement shapes enforced; damage rides on the RETURN', async () => {
  await rejects(sql(app, T1, `UPDATE inventory_items SET on_hand = -1 WHERE id = 'i1'`), /inventory_items_on_hand_nonneg/);
  await rejects(sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta) VALUES ('ix','t1','i1','ISSUE',-5)`), /inventory_movements_shape/); // no session
  await rejects(sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, session_id) VALUES ('ix','t1','i1','ISSUE',5,'s1')`), /inventory_movements_shape/); // wrong sign
  await sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, session_id, unit_cost) VALUES ('im3','t1','i1','ISSUE',-10,'s1',250)`);
  await rejects(sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, session_id, returned_qty, damaged_qty)
                              VALUES ('im4','t1','i1','RETURN',2,'s1',8,2)`), /inventory_movements_shape/); // stock_delta must equal returned_qty
  await sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, session_id, returned_qty, damaged_qty, unit_cost)
                      VALUES ('im5','t1','i1','RETURN',8,'s1',8,2,250)`);
  const rec = await sql(app, T1, `SELECT -SUM(stock_delta) FILTER (WHERE type='ISSUE') AS issued,
                                         SUM(returned_qty) AS returned, SUM(damaged_qty) AS damaged
                                    FROM inventory_movements WHERE session_id = 's1'`);
  assert.equal(Number(rec.rows[0].issued), Number(rec.rows[0].returned) + Number(rec.rows[0].damaged)); // reconciled
  await rejects(sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, expense_id) VALUES ('im6','t1','i1','ADJUSTMENT',-1,'e1')`), /expense_only_purchase/);
  await sql(app, T1, `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, expense_id) VALUES ('im7','t1','i1','PURCHASE',20,'e1')`);
});

// The comparison the nightly `inventory.reconcile` job runs per tenant (docs/05 §10).
const RECONCILE_SQL = `
  SELECT i.id, i.on_hand, COALESCE(SUM(m.stock_delta), 0)::int AS ledger
    FROM inventory_items i
    LEFT JOIN inventory_movements m ON m.item_id = i.id AND m.tenant_id = i.tenant_id
   WHERE i.id = ANY($1)
   GROUP BY i.id, i.on_hand
  HAVING i.on_hand <> COALESCE(SUM(m.stock_delta), 0)`;

test('inventory example: issue 10, return 8 with 2 damaged -> on_hand drops by 2, not 4; ledger reconciles', async () => {
  // Same sequence the API runs: lock the item row, insert the movement, update on_hand, one transaction each.
  const move = (id, type, delta, extra = {}) =>
    ctx(app, T1, async (c) => {
      const item = (await c.query(`SELECT on_hand FROM inventory_items WHERE id = 'i2' FOR UPDATE`)).rows[0];
      await c.query(
        `INSERT INTO inventory_movements (id, tenant_id, item_id, type, stock_delta, session_id, returned_qty, damaged_qty, unit_cost)
         VALUES ($1,'t1','i2',$2,$3,$4,$5,$6,250)`,
        [id, type, delta, extra.session ?? null, extra.returned ?? null, extra.damaged ?? null]);
      await c.query(`UPDATE inventory_items SET on_hand = $1 WHERE id = 'i2'`, [item.on_hand + delta]);
    });
  const onHand = async () => (await sql(app, T1, `SELECT on_hand FROM inventory_items WHERE id = 'i2'`)).rows[0].on_hand;

  await sql(app, T1, `INSERT INTO inventory_items (id, tenant_id, name, category, on_hand, unit_cost) VALUES ('i2','t1','Chair','furniture',0,250)`);
  await move('r-buy', 'PURCHASE', 100);
  assert.equal(await onHand(), 100);
  await move('r-issue', 'ISSUE', -10, { session: 's1' });
  assert.equal(await onHand(), 90);
  await move('r-return', 'RETURN', 8, { session: 's1', returned: 8, damaged: 2 });
  assert.equal(await onHand(), 98); // 100 - 2 broken/lost, NOT 100 - 4

  assert.equal((await sql(app, T1, RECONCILE_SQL, [['i2']])).rowCount, 0); // ledger agrees with on_hand
  const rec = (await sql(app, T1, `SELECT -SUM(stock_delta) FILTER (WHERE type='ISSUE') AS issued, SUM(returned_qty) AS returned, SUM(damaged_qty) AS damaged
                                     FROM inventory_movements WHERE item_id = 'i2' AND session_id = 's1'`)).rows[0];
  assert.equal(Number(rec.issued), Number(rec.returned) + Number(rec.damaged)); // session reconciled
  const damage = (await sql(app, T1, `SELECT SUM(damaged_qty * unit_cost) AS v FROM inventory_movements WHERE item_id = 'i2'`)).rows[0];
  assert.equal(Number(damage.v), 500); // 2 chairs x 250 cost snapshot

  // A drifted counter (bug, manual edit) is exactly what the nightly job reports.
  await sql(app, T1, `UPDATE inventory_items SET on_hand = 97 WHERE id = 'i2'`);
  const drift = await sql(app, T1, RECONCILE_SQL, [['i2']]);
  assert.equal(drift.rowCount, 1);
  assert.deepEqual([drift.rows[0].on_hand, drift.rows[0].ledger], [97, 98]);
});

// ───────────────────────────── jobs role ─────────────────────────────

test('venueos_jobs: sees all tenants on the scanner tables, SELECT only, nothing else', async () => {
  const b = await jobs.query('SELECT DISTINCT tenant_id FROM bookings ORDER BY 1');
  assert.deepEqual(b.rows.map((r) => r.tenant_id), ['t1', 't2']);
  await rejects(jobs.query(`UPDATE bookings SET notes = 'x'`), /permission denied/);
  for (const t of ['users', 'user_credentials', 'auth_sessions', 'payments', 'customers', 'audit_logs']) {
    await rejects(jobs.query(`SELECT 1 FROM ${t} LIMIT 1`), /permission denied/);
  }
});
