-- Module 2 (staff, roles and audit).
--
-- 1) roles.active: a role can be retired (not deleted) once nobody uses it. Retired roles cannot be assigned, copied
--    or edited; the table already has forced RLS and the rev trigger, so nothing else changes.
-- 2) audit_logs.venue_id: the venue an audited entity belongs to (venue, space, slot template; later bookings), so a
--    venue-limited reader of the audit log only sees rows of their own venues. NULL = tenant-wide (settings, roles,
--    staff, event types). The column is written by AuditService at insert time; audit_logs stays append-only for
--    venueos_app (no UPDATE, no DELETE), so the back-fill below runs here, as the table owner.

ALTER TABLE "roles" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "audit_logs" ADD COLUMN "venue_id" TEXT;

CREATE INDEX "audit_logs_tenant_id_venue_id_created_at_idx" ON "audit_logs"("tenant_id", "venue_id", "created_at");

-- Back-fill rows written before this migration. The owner is subject to FORCE ROW LEVEL SECURITY, so lift it for
-- the duration of the statements (same transaction) and put it back.
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;

UPDATE "audit_logs" SET "venue_id" = "entity_id"
 WHERE "entity_type" = 'venue' AND "venue_id" IS NULL
   AND EXISTS (SELECT 1 FROM "venues" v WHERE v."id" = "audit_logs"."entity_id" AND v."tenant_id" = "audit_logs"."tenant_id");

UPDATE "audit_logs" a SET "venue_id" = s."venue_id"
  FROM "spaces" s
 WHERE a."entity_type" = 'space' AND a."venue_id" IS NULL
   AND s."id" = a."entity_id" AND s."tenant_id" = a."tenant_id";

UPDATE "audit_logs" a SET "venue_id" = st."venue_id"
  FROM "slot_templates" st
 WHERE a."entity_type" = 'slot_template' AND a."venue_id" IS NULL
   AND st."id" = a."entity_id" AND st."tenant_id" = a."tenant_id";

ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
