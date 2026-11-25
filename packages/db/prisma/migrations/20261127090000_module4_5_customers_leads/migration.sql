-- Modules 4 and 5 (customers and leads).
--
-- 1) customers: soft delete (`active`); trigram indexes for contains / prefix search on name, phone and email; a btree
--    on lower(email) for duplicate detection. Phone stays NOT unique (docs/05 section 12).
-- 2) leads: `venue_id` (required: venue scoping applies), custom field values, `follow_up_notified_for` (the follow-up
--    the overdue email was sent for: "once per follow-up"), CHECKs for the stage rules of docs/05 section 12, and the
--    indexes of the lead board and the scanner.
-- 3) A leads-specific `touch_row`: stamping `follow_up_notified_for` (the worker) does not bump `rev` / `updated_at`,
--    so a notification can never make somebody's open edit form stale.
-- 4) The queues of the follow-up scanner and its per-lead job (created by the migrator, like every queue).
-- 5) Permission back-fill: the system "Branch manager" role gets `customer.view_sensitive` (docs/01), and a role that can
--    manage customers or leads can also view them.

-- ───────────────────────────── customers ─────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "customers" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "customers_name_trgm" ON "customers" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "customers_phone_trgm" ON "customers" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX "customers_email_trgm" ON "customers" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "customers_tenant_lower_email_idx" ON "customers" ("tenant_id", lower("email")) WHERE "email" IS NOT NULL;

-- ───────────────────────────── leads ─────────────────────────────

-- The migrator owns these tables and FORCE ROW LEVEL SECURITY applies to it: lift it for the data statements (same
-- transaction) and put it back.
ALTER TABLE "leads" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "venues" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "leads" ADD COLUMN "venue_id" TEXT;
ALTER TABLE "leads" ADD COLUMN "custom_fields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "leads" ADD COLUMN "follow_up_notified_for" TIMESTAMPTZ(6);

-- Rows that predate the module (none in practice: nothing wrote leads before) are brought in line with the new rules
-- instead of failing the migration; a tenant with leads but no venue stops it (nothing is guessed or deleted).
UPDATE "leads" l SET "venue_id" = (
  SELECT v."id" FROM "venues" v WHERE v."tenant_id" = l."tenant_id" ORDER BY v."created_at", v."id" LIMIT 1
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "leads" WHERE "venue_id" IS NULL) THEN
    RAISE EXCEPTION 'module4_5: a tenant has leads but no venue to put them in';
  END IF;
END $$;
UPDATE "leads" SET "source" = 'other' WHERE "source" NOT IN ('walk_in', 'phone', 'whatsapp', 'web', 'referral', 'other');
UPDATE "leads" SET "lost_reason" = 'Not recorded' WHERE "stage" = 'LOST' AND ("lost_reason" IS NULL OR btrim("lost_reason") = '');
UPDATE "leads" SET "next_follow_up_at" = now(), "follow_up_notified_for" = now()
 WHERE "stage" NOT IN ('WON', 'LOST') AND "next_follow_up_at" IS NULL;
UPDATE "leads" SET "guests" = NULL WHERE "guests" IS NOT NULL AND ("guests" < 1 OR "guests" > 100000);
UPDATE "leads" SET "budget" = NULL WHERE "budget" < 0;

ALTER TABLE "leads" ALTER COLUMN "venue_id" SET NOT NULL;
ALTER TABLE "leads" ADD CONSTRAINT "leads_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "venues" FORCE ROW LEVEL SECURITY;

ALTER TABLE "leads" ADD CONSTRAINT "leads_source_check"
  CHECK ("source" IN ('walk_in', 'phone', 'whatsapp', 'web', 'referral', 'other'));
-- docs/05 section 12: LOST needs a reason; an open lead needs a next follow-up.
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_needs_reason"
  CHECK ("stage" <> 'LOST' OR btrim(coalesce("lost_reason", '')) <> '');
ALTER TABLE "leads" ADD CONSTRAINT "leads_open_needs_follow_up"
  CHECK ("stage" IN ('WON', 'LOST') OR "next_follow_up_at" IS NOT NULL);
ALTER TABLE "leads" ADD CONSTRAINT "leads_guests_range" CHECK ("guests" IS NULL OR ("guests" >= 1 AND "guests" <= 100000));
ALTER TABLE "leads" ADD CONSTRAINT "leads_budget_nonneg" CHECK ("budget" IS NULL OR "budget" >= 0);

CREATE INDEX "leads_tenant_id_venue_id_stage_idx" ON "leads" ("tenant_id", "venue_id", "stage");
CREATE INDEX "leads_tenant_id_assignee_id_idx" ON "leads" ("tenant_id", "assignee_id");
-- What the follow-up scanner walks: open, assigned leads with a follow-up.
CREATE INDEX "leads_follow_up_due_idx" ON "leads" ("next_follow_up_at")
  WHERE "stage" NOT IN ('WON', 'LOST') AND "assignee_id" IS NOT NULL AND "next_follow_up_at" IS NOT NULL;

-- Only `follow_up_notified_for` changed (the worker's "mail sent" stamp): keep rev and updated_at.
CREATE OR REPLACE FUNCTION touch_row_leads() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSIF (to_jsonb(NEW) - 'follow_up_notified_for' - 'rev' - 'updated_at')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'follow_up_notified_for' - 'rev' - 'updated_at') THEN
    NEW.rev := OLD.rev;
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.rev := OLD.rev + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS touch_row ON "leads";
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON "leads"
  FOR EACH ROW EXECUTE FUNCTION touch_row_leads();

-- ───────────────────────────── queues ─────────────────────────────
-- Same convention as the earlier queue migrations. `leads.follow-up` is the scheduled scanner (a system job);
-- `leads.follow-up.notify` is the per-lead job it enqueues, one per due lead (singleton key = the lead).

SELECT pgboss.create_queue('leads.follow-up.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('leads.follow-up', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":900,"deadLetter":"leads.follow-up.dead"}'::jsonb);

SELECT pgboss.create_queue('leads.follow-up.notify.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('leads.follow-up.notify', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":300,"deadLetter":"leads.follow-up.notify.dead"}'::jsonb);

-- ───────────────────────────── permissions back-fill ─────────────────────────────

ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

UPDATE "roles" SET "permissions" = array_append("permissions", 'customer.view_sensitive')
 WHERE "is_system" AND "name" = 'Branch manager' AND NOT ('customer.view_sensitive' = ANY("permissions"));
UPDATE "roles" SET "permissions" = array_append("permissions", 'customer.view')
 WHERE 'customer.manage' = ANY("permissions") AND NOT ('customer.view' = ANY("permissions"));
UPDATE "roles" SET "permissions" = array_append("permissions", 'lead.view')
 WHERE 'lead.manage' = ANY("permissions") AND NOT ('lead.view' = ANY("permissions"));

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
