// Run from packages/db:  pnpm add -D embedded-postgres pg && node tests/db-constraints.test.mjs
// Spins up a throwaway Postgres, applies prisma/sql/001_constraints_and_rls.sql on minimal tables,
// and checks double-booking prevention, occupancy sync, RLS tenant isolation and pre-tenant access.

import EmbeddedPostgres from 'embedded-postgres';
import fs from 'fs';
import pg from 'pg';
const db = new EmbeddedPostgres({ databaseDir: './.pgtest-data', user: 'postgres', password: 'pw', port: 54329, persistent: false });
await db.initialise(); await db.start();
const su = db.getPgClient(); await su.connect();
await su.query(`
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT','TENTATIVE','CONFIRMED','COMPLETED','CANCELLED','EXPIRED');
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED');
CREATE TABLE tenants (id text PRIMARY KEY, name text, slug text UNIQUE, "customDomain" text, status "TenantStatus" NOT NULL DEFAULT 'TRIAL');
CREATE TABLE memberships (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), "userId" text NOT NULL);
CREATE TABLE spaces (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text);
CREATE TABLE bookings (id text PRIMARY KEY, tenant_id text NOT NULL, status "BookingStatus" NOT NULL DEFAULT 'DRAFT');
CREATE TABLE booking_sessions (id text PRIMARY KEY, tenant_id text NOT NULL, "bookingId" text NOT NULL REFERENCES bookings(id), "spaceId" text);
CREATE TABLE space_occupancies (id text PRIMARY KEY, tenant_id text NOT NULL, session_id text NOT NULL REFERENCES booking_sessions(id), space_id text NOT NULL REFERENCES spaces(id), starts_at timestamptz(6) NOT NULL, ends_at timestamptz(6) NOT NULL, active boolean NOT NULL DEFAULT true);
`);
await su.query(fs.readFileSync(new URL('../prisma/sql/001_constraints_and_rls.sql', import.meta.url),'utf8'));
await su.query(`CREATE ROLE app_user LOGIN PASSWORD 'app'; GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO app_user;
INSERT INTO tenants VALUES ('t1','Royal','royal',NULL,'ACTIVE'),('t2','Grand','grand',NULL,'ACTIVE'),('t3','Old','old',NULL,'SUSPENDED');
INSERT INTO memberships VALUES ('m1','t1','u1'),('m2','t2','u1'),('m3','t2','u2');`);
const app = new pg.Client({ host:'localhost', port:54329, user:'app_user', password:'app', database:'postgres' }); await app.connect();
const asTenant = async (t, sql, params=[]) => { await app.query('BEGIN'); try { await app.query("SELECT set_config('app.tenant_id',$1,true)",[t]); const r = await app.query(sql, params); await app.query('COMMIT'); return r; } catch(e){ await app.query('ROLLBACK'); throw e; } };
const ok = (name, cond) => console.log((cond?'PASS ':'FAIL ')+name);
const expectErr = async (name, fn, re) => { try { await fn(); ok(name+' (no error!)', false);} catch(e){ ok(name+' -> '+e.message.split('\n')[0], re.test(e.message)); } };

await asTenant('t1', `INSERT INTO spaces VALUES ('hallA','t1','Hall A'),('hallB','t1','Hall B')`);
await asTenant('t2', `INSERT INTO spaces VALUES ('g1','t2','Grand Hall')`);
await expectErr('RLS blocks writing another tenant row', () => asTenant('t1', `INSERT INTO spaces VALUES ('x','t2','x')`), /row-level security/);
ok('RLS hides other tenant rows', (await asTenant('t1','SELECT * FROM spaces')).rowCount === 2);
ok('No tenant set -> no rows', (await app.query('SELECT * FROM spaces')).rowCount === 0);

// booking 1: dinner Hall A, tentative
await asTenant('t1', `INSERT INTO bookings VALUES ('b1','t1','TENTATIVE'); INSERT INTO booking_sessions VALUES ('s1','t1','b1','hallA');
 INSERT INTO space_occupancies VALUES ('o1','t1','s1','hallA','2027-02-14 18:00+05','2027-02-15 00:00+05',true)`);
await asTenant('t1', `INSERT INTO bookings VALUES ('b2','t1','TENTATIVE'); INSERT INTO booking_sessions VALUES ('s2','t1','b2','hallA')`);
await expectErr('Overlapping dinner on same hall rejected', () => asTenant('t1', `INSERT INTO space_occupancies VALUES ('o2','t1','s2','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05',true)`), /space_occupancies_no_overlap/);
await asTenant('t1', `INSERT INTO space_occupancies VALUES ('o3','t1','s2','hallA','2027-02-14 12:00+05','2027-02-14 18:00+05',true)`); ok('Back-to-back lunch (ends 18:00) allowed', true);
await asTenant('t1', `INSERT INTO space_occupancies VALUES ('o4','t1','s2','hallB','2027-02-14 19:00+05','2027-02-14 23:30+05',true)`); ok('Same time, different hall allowed', true);
// combined A+B booking writes rows for both -> blocked
await asTenant('t1', `INSERT INTO bookings VALUES ('b3','t1','TENTATIVE'); INSERT INTO booking_sessions VALUES ('s3','t1','b3','hallAB')`);
await expectErr('Combined A+B blocked by existing Hall B row', () => asTenant('t1', `INSERT INTO space_occupancies VALUES ('o5','t1','s3','hallA','2027-02-20 19:00+05','2027-02-20 23:00+05',true),('o6','t1','s3','hallB','2027-02-14 20:00+05','2027-02-14 23:00+05',true)`), /no_overlap/);
// cancel b1 releases dinner slot
await asTenant('t1', `UPDATE bookings SET status='CANCELLED' WHERE id='b1'`);
ok('Cancel releases occupancy', (await asTenant('t1',`SELECT active FROM space_occupancies WHERE id='o1'`)).rows[0].active === false);
await asTenant('t1', `INSERT INTO space_occupancies VALUES ('o7','t1','s2','hallA','2027-02-14 19:00+05','2027-02-14 23:30+05',true)`); ok('Freed dinner slot can be rebooked', true);
await expectErr('Re-confirming cancelled booking fails when slot taken', () => asTenant('t1', `UPDATE bookings SET status='CONFIRMED' WHERE id='b1'`), /no_overlap/);
await expectErr('Invalid range rejected', () => asTenant('t1', `INSERT INTO space_occupancies VALUES ('o8','t1','s2','hallA','2027-03-01 20:00+05','2027-03-01 19:00+05',true)`), /valid_range/);
// pre-tenant context: user u1 sees own memberships + tenants only
const asUser = async (u, sql) => { await app.query('BEGIN'); await app.query("SELECT set_config('app.user_id',$1,true)",[u]); const r = await app.query(sql); await app.query('COMMIT'); return r; };
ok('User sees only own memberships before choosing tenant', (await asUser('u1','SELECT * FROM memberships')).rowCount === 2);
ok('User sees only tenants they belong to', (await asUser('u2','SELECT id FROM tenants')).rows.map(r=>r.id).join() === 't2');
ok('No context -> tenants hidden', (await app.query('SELECT * FROM tenants')).rowCount === 0);
ok('Public resolve_tenant(slug) works without context', (await app.query("SELECT resolve_tenant('royal') AS id")).rows[0].id === 't1');
ok('resolve_tenant ignores suspended tenants', (await app.query("SELECT resolve_tenant('old') AS id")).rows[0].id === null);
const missing = await su.query(`SELECT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name
  WHERE c.table_schema='public' AND c.column_name='tenant_id' AND NOT (k.relrowsecurity AND k.relforcerowsecurity)`);
ok('Every tenant_id table has forced RLS' + (missing.rowCount ? ' (missing: '+missing.rows.map(r=>r.table_name).join(', ')+')' : ''), missing.rowCount === 0);
await app.end(); await su.end(); await db.stop();
