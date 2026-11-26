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
const T2 = { tenant: 't2' };
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
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, receipt_no) VALUES ('px','t1','bk2','CASH',10,'R-px')`), /foreign key/);
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
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status, idempotency_key, receipt_no)
                      VALUES ('p1','t1','b5','CHEQUE',50000.5,'PENDING','key-1','R-p1')`);
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
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, receipt_no) VALUES ('p0','t1','b5','CASH',0,'R-p0')`), /payments_amount_positive/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type) VALUES ('p0','t1','b5','CASH',10,'REVERSAL')`), /payments_reversal_link/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, reverses_id, receipt_no) VALUES ('p0','t1','b5','CASH',10,'p1','R-p0')`), /payments_reversal_link/);
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, reverses_id, notes)
                      VALUES ('p2','t1','b5','CHEQUE',50000.5,'REVERSAL','p1','wrong booking')`);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, entry_type, reverses_id)
                      VALUES ('p3','t1','b5','CHEQUE',50000.5,'REVERSAL','p1')`), /payments_reverses_id_key/);
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, refund_request_id, receipt_no) VALUES ('p4','t1','b5','CASH',5,'rr-none','R-p4')`), /payments_refund_link|foreign key/);
});

test('payment status: only CHEQUE may be PENDING/BOUNCED; other methods are CLEARED on entry', async () => {
  for (const method of ['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'ONLINE_GATEWAY']) {
    await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status, receipt_no) VALUES ('ps','t1','b5','${method}',5,'PENDING','R-ps')`), /payments_status_by_method/);
    await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status, receipt_no) VALUES ('ps','t1','b5','${method}',5,'BOUNCED','R-ps')`), /payments_status_by_method/);
    await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, receipt_no) VALUES ('ps-${method}','t1','b5','${method}',5,'R-ps-${method}')`); // default CLEARED
  }
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, status, receipt_no) VALUES ('ps-chq','t1','b5','CHEQUE',5,'PENDING','R-chq')`);
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
  await rejects(sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, idempotency_key, receipt_no) VALUES ('p7','t1','b5','CASH',5,'key-1','R-p7')`), /idempotency_key/);
  await sql(app, { tenant: 't2' }, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, idempotency_key, receipt_no) VALUES ('p8','t2','bk2','CASH',5,'key-1','R-p8')`); // other tenant: fine
  await sql(app, T1, `INSERT INTO payments (id, tenant_id, booking_id, method, amount, receipt_no) VALUES ('p9','t1','b5','CASH',5,'R-p9'),('p10','t1','b5','CASH',5,'R-p10')`); // NULL keys never collide
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

// ───────────────────────────── pg-boss schema ─────────────────────────────

test('pgboss: venueos_app can only enqueue and read readiness facts; no DDL, no update/delete of jobs', async () => {
  // Enqueue: SELECT queue (cache lookup), INSERT + SELECT on job (INSERT ... RETURNING).
  await sql(app, T1, `SELECT name FROM pgboss.queue`);
  await sql(app, T1, `SELECT version FROM pgboss.version`);
  const ins = await sql(app, T1, `
    INSERT INTO pgboss.job (name, data, singleton_key) VALUES ('email.send', '{"tenantId":"t1","messageKey":"mk-grant"}', 'mk-grant') RETURNING id`);
  assert.equal(ins.rowCount, 1);
  await rejects(sql(app, T1, `UPDATE pgboss.job SET state = 'cancelled'`), /permission denied/);
  await rejects(sql(app, T1, `DELETE FROM pgboss.job`), /permission denied/);
  await rejects(sql(app, T1, `UPDATE pgboss.queue SET retry_limit = 99`), /permission denied/);
  await rejects(sql(app, T1, `INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds, deletion_seconds, partition, table_name) VALUES ('x','standard',1,1,false,1,1,1,false,'job_common')`), /permission denied/);
  await rejects(sql(app, T1, `SELECT * FROM pgboss.schedule`), /permission denied/);
  await rejects(sql(app, T1, `CREATE TABLE pgboss.evil (a int)`), /permission denied/);
  await rejects(sql(app, T1, `DROP TABLE pgboss.job`), /must be owner|permission denied/);
});

test('pgboss: venueos_jobs has read/write on pgboss only; still no new reach into tenant data; no DDL', async () => {
  const r = await jobs.query(`SELECT id FROM pgboss.job WHERE singleton_key = 'mk-grant'`);
  assert.equal(r.rowCount, 1);
  await jobs.query(`UPDATE pgboss.job SET state = 'cancelled' WHERE singleton_key = 'mk-grant'`);
  await jobs.query(`DELETE FROM pgboss.job WHERE singleton_key = 'mk-grant'`);
  await rejects(jobs.query(`CREATE TABLE pgboss.evil (a int)`), /permission denied/);
  await rejects(jobs.query(`SELECT 1 FROM message_logs LIMIT 1`), /permission denied/);
  await rejects(jobs.query(`INSERT INTO message_logs (id, tenant_id, message_key, channel, "to", status) VALUES ('x','t1','x','email','a@b.test','queued')`), /permission denied/);
});

test('pgboss: venueos_auth cannot use the schema at all', async () => {
  await rejects(auth.query(`SELECT 1 FROM pgboss.job LIMIT 1`), /permission denied for schema pgboss/);
});

test('pgboss: the schema is owned by the migrator (not by an application role)', async () => {
  const own = await migrator.query(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'`);
  assert.equal(own.rows[0].owner, 'venueos_migrator');
});

test('message_logs: the email pipeline columns are insertable, the table stays append-only', async () => {
  await sql(app, T1, `
    INSERT INTO message_logs (id, tenant_id, message_key, channel, "to", status, template, locale, template_vars, reply_to)
    VALUES ('ml-q','t1','mk-q','email','a@example.test','queued','sample.hello','en','{"name":"Ali"}','b@example.test')`);
  await sql(app, T1, `
    INSERT INTO message_logs (id, tenant_id, message_key, channel, "to", status, error, attempt, is_final)
    VALUES ('ml-f','t1','mk-q','email','a@example.test','failed','PROVIDER_UNAVAILABLE',6,true)`);
  await rejects(sql(app, T1, `UPDATE message_logs SET is_final = false WHERE id = 'ml-f'`), /permission denied/);
  await rejects(sql(app, T1, `DELETE FROM message_logs WHERE id = 'ml-q'`), /permission denied/);
});

// ───────────────────────────── P0-4: auth_requests, pending invitations ─────────────────────────────

test('auth_requests: auth-only (venueos_app cannot touch it), venueos_auth has full DML', async () => {
  await sql(auth, {}, `INSERT INTO auth_requests (id, kind, email_hash, ip) VALUES ('ar1','signup','h1','10.0.0.1')`);
  await sql(auth, {}, `DELETE FROM auth_requests WHERE id = 'ar1'`);
  await rejects(sql(app, T1, `SELECT 1 FROM auth_requests`), /permission denied/);
  await rejects(sql(app, T1, `INSERT INTO auth_requests (id, kind, email_hash) VALUES ('x','signup','h')`), /permission denied/);
  await rejects(jobs.query(`SELECT 1 FROM auth_requests`), /permission denied/);
});

test('invitations: one pending invitation per tenant and email; accepted or revoked ones do not count', async () => {
  const ins = (id, hash) => sql(auth, {}, `
    INSERT INTO invitations (id, tenant_id, email, role_id, venue_ids, token_hash, expires_at)
    VALUES ('${id}','t1','pending-index@example.test','r1','{}','${hash}', now() + interval '72 hours')`);
  await ins('pinv1', 'pth1');
  await rejects(ins('pinv2', 'pth2'), /invitations_pending_email_key/);
  await sql(auth, {}, `UPDATE invitations SET revoked_at = now() WHERE id = 'pinv1'`);
  await ins('pinv3', 'pth3'); // allowed again once the first is revoked
  await sql(auth, {}, `UPDATE invitations SET accepted_at = now() WHERE id = 'pinv3'`);
  await ins('pinv4', 'pth4');
});

test('module 3: one default tax rate / cancellation policy per tenant, and a default is active', async () => {
  const tax = (id, name, isDefault) =>
    sql(
      app,
      T1,
      `INSERT INTO tax_rates (id, tenant_id, name, rate_pct, is_default, updated_at)
                  VALUES ('${id}','t1','${name}', 16, ${isDefault}, now())`,
    );
  await tax('tax1', 'GST', true);
  await rejects(tax('tax2', 'VAT', true), /tax_rates_one_default_key/);
  await tax('tax3', 'Service', false);
  // Another tenant may have its own default.
  await sql(
    app,
    T2,
    `INSERT INTO tax_rates (id, tenant_id, name, rate_pct, is_default, updated_at) VALUES ('tax_t2','t2','GST', 16, true, now())`,
  );
  // A default cannot be inactive.
  await rejects(
    sql(app, T1, `UPDATE tax_rates SET active = false WHERE id = 'tax1'`),
    /tax_rates_default_is_active/,
  );
  await sql(app, T1, `UPDATE tax_rates SET is_default = false, active = false WHERE id = 'tax1'`);
  await sql(app, T1, `UPDATE tax_rates SET is_default = true WHERE id = 'tax3'`);
  // Range check.
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO tax_rates (id, tenant_id, name, rate_pct, updated_at) VALUES ('tax4','t1','Over', 100.01, now())`,
    ),
    /tax_rates_rate_pct_range|numeric field overflow|check/i,
  );

  const policy = (id, name, def) =>
    sql(
      app,
      T1,
      `INSERT INTO cancellation_policies (id, tenant_id, name, tiers, is_default, updated_at)
                  VALUES ('${id}','t1','${name}','[{"minDaysBefore":0,"refundPct":0}]', ${def}, now())`,
    );
  await policy('cp1', 'Standard', true);
  await rejects(policy('cp2', 'Strict', true), /cancellation_policies_one_default_key/);
  await policy('cp3', 'Strict', false);
  await rejects(
    sql(app, T1, `UPDATE cancellation_policies SET active = false WHERE id = 'cp1'`),
    /cancellation_policies_default_is_active/,
  );
});

test('module 3: catalogue names are unique among active rows, case-insensitively', async () => {
  const item = (id, name, active = true) =>
    sql(
      app,
      T1,
      `INSERT INTO menu_items (id, tenant_id, name, active, updated_at) VALUES ('${id}','t1','${name}', ${active}, now())`,
    );
  await item('mi1', 'Chicken Karahi');
  await rejects(item('mi2', 'chicken karahi'), /menu_items_active_name_key/);
  await item('mi3', 'Chicken karahi', false); // an inactive row does not count
  await rejects(
    sql(app, T1, `UPDATE menu_items SET active = true WHERE id = 'mi3'`),
    /menu_items_active_name_key/,
  );
  await sql(
    app,
    T2,
    `INSERT INTO menu_items (id, tenant_id, name, updated_at) VALUES ('mi_t2','t2','Chicken Karahi', now())`,
  );

  await sql(
    app,
    T1,
    `INSERT INTO packages (id, tenant_id, name, per_head_rate, updated_at) VALUES ('pk1','t1','Menu A', 1500, now())`,
  );
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO packages (id, tenant_id, name, per_head_rate, updated_at) VALUES ('pk2','t1','MENU A', 1500, now())`,
    ),
    /packages_active_name_key/,
  );
  await sql(
    app,
    T1,
    `INSERT INTO add_ons (id, tenant_id, name, price, updated_at) VALUES ('ad1','t1','DJ', 5000, now())`,
  );
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO add_ons (id, tenant_id, name, price, updated_at) VALUES ('ad2','t1','dj', 5000, now())`,
    ),
    /add_ons_active_name_key/,
  );
});

test('module 3: money, quantity and date-range sanity checks', async () => {
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO packages (id, tenant_id, name, per_head_rate, updated_at) VALUES ('pkneg','t1','Negative', -1, now())`,
    ),
    /packages_per_head_rate_nonneg/,
  );
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO packages (id, tenant_id, name, per_head_rate, min_guests, updated_at) VALUES ('pkneg2','t1','Negative guests', 1, -1, now())`,
    ),
    /packages_min_guests_nonneg/,
  );
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO add_ons (id, tenant_id, name, price, updated_at) VALUES ('adneg','t1','Negative', -5, now())`,
    ),
    /add_ons_price_nonneg/,
  );
  await rejects(
    sql(
      app,
      T1,
      `INSERT INTO package_items (tenant_id, package_id, menu_item_id, quantity) VALUES ('t1','pk1','mi1', 0)`,
    ),
    /package_items_quantity_positive/,
  );
  const rule = (id, start, end) =>
    sql(
      app,
      T1,
      `INSERT INTO price_rules (id, tenant_id, name, kind, days_of_week, start_date, end_date, adjustment, value, updated_at)
                  VALUES ('${id}','t1','Season','DATE_RANGE','{}','${start}','${end}','PERCENT', 10, now())`,
    );
  await rule('pr1', '2027-11-01', '2027-12-31');
  await rejects(rule('pr2', '2027-12-31', '2027-11-01'), /price_rules_date_order/);
});

test('module 3: tax rates, cancellation policies and custom field definitions can be deactivated', async () => {
  const { rows } = await migrator.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'active' AND table_name IN ('tax_rates','cancellation_policies','custom_field_defs') ORDER BY 1`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['cancellation_policies', 'custom_field_defs', 'tax_rates'],
  );
});

// ───────────────────────────── modules 4 and 5: customers and leads ─────────────────────────────

test('module 5 leads: the stage rules, source, venue and ranges are enforced by CHECKs and keys', async () => {
  const lead = (id, cols = '', vals = '') =>
    sql(
      app,
      T1,
      `INSERT INTO leads (id, tenant_id, venue_id, customer_id, source, stage, next_follow_up_at, updated_at ${cols})
       VALUES ('${id}','t1','v1','c1','phone','NEW', now() + interval '1 day', now() ${vals})`,
    );
  await lead('ld1');
  // venue_id is required and must exist.
  await rejects(
    sql(app, T1, `INSERT INTO leads (id, tenant_id, customer_id, source, stage, next_follow_up_at, updated_at) VALUES ('ldx','t1','c1','phone','NEW', now(), now())`),
    /venue_id/,
  );
  await rejects(
    sql(app, T1, `INSERT INTO leads (id, tenant_id, venue_id, customer_id, source, stage, next_follow_up_at, updated_at) VALUES ('ldx','t1','nope','c1','phone','NEW', now(), now())`),
    /leads_venue_id_fkey/,
  );
  // An open lead needs a follow-up; LOST needs a reason; the source is one of the six.
  await rejects(sql(app, T1, `UPDATE leads SET next_follow_up_at = NULL WHERE id = 'ld1'`), /leads_open_needs_follow_up/);
  await rejects(sql(app, T1, `UPDATE leads SET stage = 'LOST' WHERE id = 'ld1'`), /leads_lost_needs_reason/);
  await rejects(sql(app, T1, `UPDATE leads SET stage = 'LOST', lost_reason = '  ' WHERE id = 'ld1'`), /leads_lost_needs_reason/);
  await rejects(sql(app, T1, `UPDATE leads SET source = 'marketplace' WHERE id = 'ld1'`), /leads_source_check/);
  await rejects(sql(app, T1, `UPDATE leads SET guests = 0 WHERE id = 'ld1'`), /leads_guests_range/);
  await rejects(sql(app, T1, `UPDATE leads SET budget = -1 WHERE id = 'ld1'`), /leads_budget_nonneg/);
  // Closing a lead clears the follow-up and sets the reason in one statement.
  await sql(app, T1, `UPDATE leads SET stage = 'LOST', lost_reason = 'Went elsewhere', next_follow_up_at = NULL WHERE id = 'ld1'`);
  await sql(app, T1, `UPDATE leads SET stage = 'WON', lost_reason = NULL WHERE id = 'ld1'`);
  // Another tenant's venue cannot be used: RLS hides it from this tenant's foreign key check path as well as reads.
  assert.equal((await sql(app, T2, `SELECT id FROM leads WHERE id = 'ld1'`)).rows.length, 0);
});

test('module 5 leads: stamping follow_up_notified_for does not bump rev or updated_at, every other change does', async () => {
  await sql(
    app,
    T1,
    `INSERT INTO leads (id, tenant_id, venue_id, customer_id, source, stage, next_follow_up_at, updated_at)
     VALUES ('ld2','t1','v1','c1','phone','CONTACTED', now() - interval '1 hour', now() - interval '1 day')`,
  );
  const read = async () =>
    (await sql(app, T1, `SELECT rev, updated_at, follow_up_notified_for FROM leads WHERE id = 'ld2'`)).rows[0];
  const first = await read();
  await sql(app, T1, `UPDATE leads SET follow_up_notified_for = next_follow_up_at WHERE id = 'ld2'`);
  const stamped = await read();
  assert.equal(stamped.rev, first.rev);
  assert.equal(stamped.updated_at.getTime(), first.updated_at.getTime());
  assert.notEqual(stamped.follow_up_notified_for, null);
  await sql(app, T1, `UPDATE leads SET notes = 'called' WHERE id = 'ld2'`);
  const edited = await read();
  assert.equal(edited.rev, first.rev + 1);
  assert.ok(edited.updated_at > first.updated_at);
  // Stamping together with a real change still counts as a change.
  await sql(app, T1, `UPDATE leads SET follow_up_notified_for = NULL, notes = 'again' WHERE id = 'ld2'`);
  assert.equal((await read()).rev, first.rev + 2);
});

test('module 5 leads: the scanner role reads leads and the follow-up queues exist', async () => {
  const due = await jobs.query(
    `SELECT id, tenant_id FROM leads WHERE stage NOT IN ('WON','LOST') AND next_follow_up_at <= now() AND id = 'ld2'`,
  );
  assert.equal(due.rows.length, 1);
  await rejects(jobs.query(`UPDATE leads SET notes = 'x' WHERE id = 'ld2'`), /permission denied/);
  const queues = await migrator.query(
    `SELECT name FROM pgboss.queue WHERE name LIKE 'leads.follow-up%' ORDER BY name`,
  );
  assert.deepEqual(queues.rows.map((r) => r.name), [
    'leads.follow-up',
    'leads.follow-up.dead',
    'leads.follow-up.notify',
    'leads.follow-up.notify.dead',
  ]);
});

test('module 4 customers: phone is not unique, search indexes exist, customers can be deactivated', async () => {
  await sql(app, T1, `INSERT INTO customers (id, tenant_id, name, phone, updated_at) VALUES ('c1dup','t1','Twin','+923001112233', now())`);
  await sql(app, T1, `INSERT INTO customers (id, tenant_id, name, phone, updated_at) VALUES ('c1dup2','t1','Twin 2','+923001112233', now())`);
  await sql(app, T1, `UPDATE customers SET active = false WHERE id = 'c1dup2'`);
  const idx = await migrator.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'customers' AND indexname IN
       ('customers_name_trgm','customers_phone_trgm','customers_email_trgm','customers_tenant_lower_email_idx') ORDER BY 1`,
  );
  assert.equal(idx.rows.length, 4);
  // The app role cannot hard-delete a customer that has leads (and never needs to).
  await sql(app, T1, `INSERT INTO leads (id, tenant_id, venue_id, customer_id, source, stage, next_follow_up_at, updated_at) VALUES ('ld3','t1','v1','c1dup','phone','NEW', now(), now())`);
  await rejects(sql(app, T1, `DELETE FROM customers WHERE id = 'c1dup'`), /foreign key|violates/);
});

// ───────────────────────────── modules 6-8 (availability, quotations, bookings) ─────────────────────────────

test('modules 6-8 bookings: hold_warned_at does not bump rev, every other change does; checks reject bad values', async () => {
  await sql(
    app,
    T1,
    `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency, status, number, hold_expires_at, updated_at)
     VALUES ('bkw','t1','v1','c1','PKR','TENTATIVE','BK-2031-9001', now() + interval '1 hour', now() - interval '1 day')`,
  );
  const read = async () => (await sql(app, T1, `SELECT rev, updated_at, hold_warned_at FROM bookings WHERE id = 'bkw'`)).rows[0];
  const first = await read();
  await sql(app, T1, `UPDATE bookings SET hold_warned_at = now() WHERE id = 'bkw'`);
  const stamped = await read();
  assert.equal(stamped.rev, first.rev);
  assert.equal(stamped.updated_at.getTime(), first.updated_at.getTime());
  assert.notEqual(stamped.hold_warned_at, null);
  await sql(app, T1, `UPDATE bookings SET hold_extensions = 1 WHERE id = 'bkw'`);
  assert.equal((await read()).rev, first.rev + 1);
  await sql(app, T1, `UPDATE bookings SET hold_warned_at = NULL, hold_extensions = 2 WHERE id = 'bkw'`);
  assert.equal((await read()).rev, first.rev + 2);
  await rejects(sql(app, T1, `UPDATE bookings SET suggested_refund = -1 WHERE id = 'bkw'`), /bookings_suggested_refund_nonneg/);
  await rejects(sql(app, T1, `UPDATE bookings SET hold_extensions = -1 WHERE id = 'bkw'`), /bookings_hold_extensions_nonneg/);
  await sql(app, T1, `UPDATE bookings SET suggested_refund = 0, cancelled_from = 'TENTATIVE' WHERE id = 'bkw'`);
});

test('modules 6-8 sessions: guest ranges are checked; frozen pricing and add-on input are stored', async () => {
  const insert = (id, guests, guaranteed) =>
    sql(
      app,
      T1,
      `INSERT INTO booking_sessions (id, tenant_id, booking_id, space_id, starts_at, ends_at, guests, guaranteed_guests, add_ons, pricing)
       VALUES ($1,'t1','bkw','hallA','2031-03-01 19:00+05','2031-03-01 23:00+05',$2,$3,'[{"addOnId":"a"}]','{"unitRent":"1000"}')`,
      [id, guests, guaranteed],
    );
  await rejects(insert('sg0', 0, null), /booking_sessions_guests_range/);
  await rejects(insert('sg1', 100001, null), /booking_sessions_guests_range/);
  await rejects(insert('sg2', 100, 0), /booking_sessions_guaranteed_range/);
  await insert('sg3', 100, 120);
  const row = (await sql(app, T1, `SELECT add_ons, pricing FROM booking_sessions WHERE id = 'sg3'`)).rows[0];
  assert.deepEqual(row.add_ons, [{ addOnId: 'a' }]);
  assert.deepEqual(row.pricing, { unitRent: '1000' });
});

test('modules 6-8 queues: the hold and completion queues and their dead letters exist; the scanner role can read the hold sets', async () => {
  const { rows } = await migrator.query(
    `SELECT name FROM pgboss.queue WHERE name LIKE 'holds.%' OR name LIKE 'bookings.complete%' ORDER BY name`,
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    [
      'bookings.complete',
      'bookings.complete.dead',
      'bookings.complete.run',
      'bookings.complete.run.dead',
      'holds.expire',
      'holds.expire.dead',
      'holds.expire.run',
      'holds.expire.run.dead',
      'holds.warn.run',
      'holds.warn.run.dead',
    ],
  );
  const ended = await jobs.query(
    `SELECT b.id FROM bookings b WHERE b.status = 'TENTATIVE' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= now() + interval '2 hours' AND b.id = 'bkw'`,
  );
  assert.equal(ended.rows.length, 1);
  await rejects(jobs.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = 'bkw'`), /permission denied/);
});

test('modules 6-8: the bookings-specific touch_row function is installed', async () => {
  const { rows } = await migrator.query(`SELECT 1 FROM pg_proc WHERE proname = 'touch_row_bookings'`);
  assert.equal(rows.length, 1);
});

// ───────────────────────────── module 9 (payments and receipts) ─────────────────────────────

test('module 9 payments: a receipt has a number and nothing else has one; a REVERSAL points at what it negates', async () => {
  await sql(
    app,
    T1,
    `INSERT INTO bookings (id, tenant_id, venue_id, customer_id, currency, status, number, updated_at)
     VALUES ('bkp','t1','v1','c1','PKR','CONFIRMED','BK-2031-9100', now())`,
  );
  const insert = (id, entry, number, extra = '') =>
    sql(
      app,
      T1,
      `INSERT INTO payments (id, tenant_id, booking_id, entry_type, method, amount, status, receipt_no ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1,'t1','bkp',$2,'CASH',10,'CLEARED',$3 ${extra ? ', ' + extra.split('=')[1] : ''})`,
      [id, entry, number],
    );
  await rejects(insert('pm0', 'RECEIPT', null), /payments_receipt_no_by_type/);
  await rejects(insert('pm1', 'REFUND', 'BK-R-2031-00009'), /payments_receipt_no_by_type/);
  await insert('pm2', 'RECEIPT', 'BK-R-2031-00001');
  await rejects(insert('pm3', 'RECEIPT', 'BK-R-2031-00001'), /payments_tenant_id_receipt_no_key/);
  await rejects(insert('pm4', 'REVERSAL', null), /payments_reversal_link/);
  await insert('pm5', 'REVERSAL', null, "reverses_id='pm2'");
  // Once per entry.
  await rejects(insert('pm6', 'REVERSAL', null, "reverses_id='pm2'"), /payments_reverses_id_key/);
});

test('module 9 payments: the idempotency key is unique per workspace, not across workspaces', async () => {
  const put = (tenant, booking, id, key, no) =>
    sql(
      app,
      { tenant },
      `INSERT INTO payments (id, tenant_id, booking_id, method, amount, receipt_no, idempotency_key)
       VALUES ($1,$2,$3,'CASH',5,$4,$5)`,
      [id, tenant, booking, no, key],
    );
  await put('t1', 'bkp', 'pk1', 'same-key-0001', 'BK-R-2031-00101');
  await rejects(put('t1', 'bkp', 'pk2', 'same-key-0001', 'BK-R-2031-00102'), /payments_tenant_id_idempotency_key_key/);
  await put('t2', 'bk2', 'pk3', 'same-key-0001', 'BK-R-2031-00101');
});

test('module 9 refunds: the decision is recorded and the two-person rule is a CHECK', async () => {
  await sql(
    app,
    T1,
    `INSERT INTO refund_requests (id, tenant_id, booking_id, amount, reason, requested_by_id, updated_at)
     VALUES ('rf1','t1','bkp',100,'Customer cancelled','u1', now())`,
  );
  // A request that is decided names who decided it, and the other way round.
  await rejects(sql(app, T1, `UPDATE refund_requests SET status = 'APPROVED' WHERE id = 'rf1'`), /refund_requests_decision_consistent/);
  await rejects(sql(app, T1, `UPDATE refund_requests SET approved_by_id = 'u2' WHERE id = 'rf1'`), /refund_requests_decision_consistent/);
  // The requester decides their own request only as a recorded self-approval; another user never as one.
  await rejects(
    sql(app, T1, `UPDATE refund_requests SET status='APPROVED', approved_by_id='u1', self_approved=false WHERE id='rf1'`),
    /refund_requests_two_person_rule/,
  );
  await rejects(
    sql(app, T1, `UPDATE refund_requests SET status='APPROVED', approved_by_id='u2', self_approved=true WHERE id='rf1'`),
    /refund_requests_two_person_rule/,
  );
  await sql(app, T1, `UPDATE refund_requests SET status='APPROVED', approved_by_id='u2', self_approved=false WHERE id='rf1'`);
  await rejects(sql(app, T1, `DELETE FROM refund_requests WHERE id = 'rf1'`), /permission denied/);
});

test('module 9 schedule: an item has a positive amount and a label; the reminder scanner can read the schedule but not change it', async () => {
  const item = (id, label, amount) =>
    sql(
      app,
      T1,
      `INSERT INTO payment_schedule_items (id, tenant_id, booking_id, label, due_date, amount, updated_at)
       VALUES ($1,'t1','bkp',$2,'2031-02-01',$3, now())`,
      [id, label, amount],
    );
  await rejects(item('ps0', 'Advance', 0), /payment_schedule_items_amount_positive/);
  await rejects(item('ps1', '  ', 10), /payment_schedule_items_label_not_blank/);
  await item('ps2', 'Advance', 10);
  const due = await jobs.query(
    `SELECT i.id, i.tenant_id FROM payment_schedule_items i JOIN bookings b ON b.id = i.booking_id
      JOIN tenants t ON t.id = i.tenant_id WHERE NOT i.reminded AND i.id = 'ps2'`,
  );
  assert.equal(due.rows.length, 1);
  await rejects(jobs.query(`UPDATE payment_schedule_items SET reminded = true WHERE id = 'ps2'`), /permission denied/);
});

test('module 9 bookings: a payment changes paid_total without bumping rev or updated_at; a real edit still does', async () => {
  const read = async () => (await sql(app, T1, `SELECT rev, updated_at, paid_total FROM bookings WHERE id = 'bkp'`)).rows[0];
  const first = await read();
  await sql(app, T1, `UPDATE bookings SET paid_total = 5000 WHERE id = 'bkp'`);
  const paid = await read();
  assert.equal(paid.rev, first.rev);
  assert.equal(paid.updated_at.getTime(), first.updated_at.getTime());
  assert.equal(Number(paid.paid_total), 5000);
  await sql(app, T1, `UPDATE bookings SET notes = 'edited' WHERE id = 'bkp'`);
  assert.equal((await read()).rev, first.rev + 1);
  // Together with a real change it counts as an edit.
  await sql(app, T1, `UPDATE bookings SET paid_total = 6000, notes = 'again' WHERE id = 'bkp'`);
  assert.equal((await read()).rev, first.rev + 2);
});

test('module 9: receipt_files is tenant-isolated, one row per payment, and the payment-due queues exist', async () => {
  await sql(app, T1, `INSERT INTO receipt_files (id, tenant_id, payment_id, pdf_key, updated_at) VALUES ('rfile1','t1','pm2','tenants/t1/pdf/receipt/pm2.pdf', now())`);
  await rejects(
    sql(app, T1, `INSERT INTO receipt_files (id, tenant_id, payment_id, pdf_key, updated_at) VALUES ('rfile2','t1','pm2','x', now())`),
    /receipt_files_payment_id_key/,
  );
  assert.equal((await sql(app, T2, `SELECT id FROM receipt_files`)).rows.length, 0);
  await rejects(
    sql(app, T2, `INSERT INTO receipt_files (id, tenant_id, payment_id, pdf_key, updated_at) VALUES ('rfile3','t1','pm2','x', now())`),
    /row-level security|violates/,
  );
  const queues = await migrator.query(`SELECT name FROM pgboss.queue WHERE name LIKE 'reminders.payment-due%' ORDER BY name`);
  assert.deepEqual(queues.rows.map((r) => r.name), [
    'reminders.payment-due',
    'reminders.payment-due.dead',
    'reminders.payment-due.run',
    'reminders.payment-due.run.dead',
  ]);
});
