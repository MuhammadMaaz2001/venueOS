-- Local development roles. Runs once, as the Postgres superuser, when the container's data
-- directory is first created (docker-compose mounts it into /docker-entrypoint-initdb.d).
-- Production roles are created by infrastructure code with the same names and attributes.
--
-- Only CLUSTER-level objects live here. Everything database-level (grants, default privileges,
-- RLS, helper functions) is created by the migrations (see prisma/sql/001_constraints_and_rls.sql),
-- so a freshly created database (CI, the constraint tests) behaves exactly like staging/production.
--
-- Passwords are local-development placeholders only.

-- Owns the database and schema, runs migrations. NOT a superuser, so permission problems show
-- up locally instead of in production. CREATEDB is needed by `prisma migrate dev` (shadow DB)
-- and by the constraint tests (throwaway databases).
CREATE ROLE venueos_migrator LOGIN PASSWORD 'migrator_password' CREATEDB;

-- Owns SECURITY DEFINER functions such as resolve_tenant(). Cannot log in. BYPASSRLS is what
-- lets resolve_tenant() read `tenants` despite FORCE ROW LEVEL SECURITY.
CREATE ROLE venueos_definer NOLOGIN BYPASSRLS;
GRANT venueos_definer TO venueos_migrator;   -- lets migrations run ALTER FUNCTION ... OWNER TO

-- api + worker tenant work. No BYPASSRLS, not an owner.
CREATE ROLE venueos_app LOGIN PASSWORD 'app_password';

-- Used only by the API's AuthModule (sessions, credentials, tokens, invitations, login attempts).
CREATE ROLE venueos_auth LOGIN PASSWORD 'auth_password';

-- Worker scanners only: BYPASSRLS, SELECT on a handful of tables, used to find due work.
CREATE ROLE venueos_jobs LOGIN PASSWORD 'jobs_password' BYPASSRLS;

ALTER DATABASE venueos OWNER TO venueos_migrator;
GRANT CONNECT ON DATABASE venueos TO venueos_app, venueos_auth, venueos_jobs;
