-- VenueOS: constraints and policies Prisma cannot express.
-- Append to the first migration (prisma migrate dev --create-only, then paste below the generated DDL).

-- 1) Double-booking prevention ---------------------------------------------
-- Two ACTIVE occupancy rows for the same physical space may never overlap.
-- '[)' = end-exclusive, so 16:00-19:00 and 19:00-23:00 can sit back to back.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE space_occupancies
  ADD CONSTRAINT space_occupancies_valid_range CHECK (ends_at > starts_at);

ALTER TABLE space_occupancies
  ADD CONSTRAINT space_occupancies_no_overlap
  EXCLUDE USING gist (
    space_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (active);

-- 2) Keep occupancy in step with booking status ----------------------------
-- DRAFT (quotation) never blocks; TENTATIVE / CONFIRMED / COMPLETED block;
-- CANCELLED / EXPIRED release. Re-activating a cancelled booking fails with
-- the exclusion error if someone else has taken the slot meanwhile.
CREATE OR REPLACE FUNCTION sync_occupancy_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE space_occupancies o
       SET active = (NEW.status IN ('TENTATIVE', 'CONFIRMED', 'COMPLETED'))
      FROM booking_sessions s
     WHERE o.session_id = s.id
       AND s."bookingId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bookings_sync_occupancy ON bookings;
CREATE TRIGGER bookings_sync_occupancy
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_occupancy_active();

-- 3) Tenant isolation (Row Level Security) ----------------------------------
-- The app runs every request in a transaction that first does:
--   SELECT set_config('app.tenant_id', '<tenant id>', true);
-- Without it, tenant tables return no rows and reject writes.
-- Cross-tenant jobs (hold expiry, reminders, platform admin) connect as a
-- separate role created with BYPASSRLS; the app role must NOT have it.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

-- Call enable_tenant_rls('<table>') in the migration of EVERY new table that has tenant_id.
-- The CI test "every tenant_id table has forced RLS" fails if one is missed.
CREATE OR REPLACE FUNCTION enable_tenant_rls(t regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = app_current_tenant())
       WITH CHECK (tenant_id = app_current_tenant())', t);
END $fn$;

-- Apply to every existing table with a tenant_id column.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT format('%I.%I', c.table_schema, c.table_name)
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'tenant_id'
       AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM enable_tenant_rls(t::regclass);
  END LOOP;
END $$;

-- 4) Before a tenant is chosen ---------------------------------------------
-- After login the app sets app.user_id and must list the user's own memberships
-- (tenant switcher) before any app.tenant_id exists. This second policy is OR-ed
-- with tenant_isolation, so a user sees their own membership rows in any tenant,
-- and nothing else.
CREATE OR REPLACE FUNCTION app_current_user() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

DROP POLICY IF EXISTS membership_self ON memberships;
CREATE POLICY membership_self ON memberships
  FOR SELECT USING ("userId" = app_current_user());

-- Tenants: visible when it is the active tenant or the user is a member of it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON tenants;
CREATE POLICY tenant_visible ON tenants
  USING (
    id = app_current_tenant()
    OR EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = tenants.id AND m."userId" = app_current_user())
  );

-- Public pages (subdomain -> tenant) run before anyone logs in. This function is the
-- ONLY way to read tenants without context; it returns the id and nothing else.
CREATE OR REPLACE FUNCTION resolve_tenant(p_host_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenants
   WHERE (slug = p_host_slug OR "customDomain" = p_host_slug)
     AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
$$;
REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO venueos_app;  -- run after creating the app role
