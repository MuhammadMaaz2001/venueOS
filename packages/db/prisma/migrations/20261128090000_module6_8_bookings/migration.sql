-- Modules 6-8 (availability calendar, quotations, bookings).
--
-- 1) bookings: `pricing` (the tax rate and discount the quote was priced with, frozen), `hold_warned_at` (the "hold expiring
--    soon" email was sent), `suggested_refund` (computed at cancellation from the policy snapshot; module 9 executes refunds),
--    `cancelled_from` (the status a restore goes back to).
-- 2) booking_sessions: `add_ons` (the add-ons chosen: the INPUT of the quote) and `pricing` (the frozen unit prices of the
--    quote: rent rules, package rate, add-on prices), so a held booking is re-priced at its own rates (docs/05 section 4).
-- 3) booking_line_items: `tax_amount`, the tax portion contained in an inclusive-tax line (gross = amount + tax_amount); the TAX
--    line is the sum of them (docs/05 section 3).
-- 4) message_logs: `attachments` (queued row only): S3 object KEYS to attach, never the file or a URL.
-- 5) indexes for the hold scanners, and the queues of the new jobs.
-- 6) Permission back-fill: a role that can create, hold, confirm, change or cancel bookings or manage quotations can also see them.

ALTER TABLE "bookings" ADD COLUMN "pricing" JSONB;
ALTER TABLE "bookings" ADD COLUMN "hold_warned_at" TIMESTAMPTZ(6);
ALTER TABLE "bookings" ADD COLUMN "suggested_refund" DECIMAL(18,3);
ALTER TABLE "bookings" ADD COLUMN "cancelled_from" "booking_status";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_suggested_refund_nonneg" CHECK ("suggested_refund" IS NULL OR "suggested_refund" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_hold_extensions_nonneg" CHECK ("hold_extensions" >= 0);

ALTER TABLE "booking_sessions" ADD COLUMN "add_ons" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "booking_sessions" ADD COLUMN "pricing" JSONB;
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_guests_range" CHECK ("guests" >= 1 AND "guests" <= 100000);
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_guaranteed_range"
  CHECK ("guaranteed_guests" IS NULL OR ("guaranteed_guests" >= 1 AND "guaranteed_guests" <= 100000));

ALTER TABLE "booking_line_items" ADD COLUMN "tax_amount" DECIMAL(18,3) NOT NULL DEFAULT 0;

ALTER TABLE "message_logs" ADD COLUMN "attachments" JSONB;

-- Scanners: tentative holds by expiry; confirmed bookings by their sessions.
CREATE INDEX "bookings_hold_expiry_idx" ON "bookings" ("hold_expires_at") WHERE "status" = 'TENTATIVE';
CREATE INDEX "booking_sessions_booking_active_idx" ON "booking_sessions" ("booking_id", "ends_at") WHERE "status" = 'ACTIVE';
CREATE INDEX "bookings_tenant_id_venue_id_status_idx" ON "bookings" ("tenant_id", "venue_id", "status");

-- Queues (created by the migrator, like every queue). Scanners: holds.expire, bookings.complete. Per-booking jobs:
-- holds.expire.run, holds.warn.run, bookings.complete.run (singleton key = the booking).
SELECT pgboss.create_queue('holds.expire.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('holds.expire', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":900,"deadLetter":"holds.expire.dead"}'::jsonb);
SELECT pgboss.create_queue('holds.expire.run.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('holds.expire.run', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":300,"deadLetter":"holds.expire.run.dead"}'::jsonb);
SELECT pgboss.create_queue('holds.warn.run.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('holds.warn.run', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":300,"deadLetter":"holds.warn.run.dead"}'::jsonb);
SELECT pgboss.create_queue('bookings.complete.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('bookings.complete', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":900,"deadLetter":"bookings.complete.dead"}'::jsonb);
SELECT pgboss.create_queue('bookings.complete.run.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('bookings.complete.run', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":300,"deadLetter":"bookings.complete.run.dead"}'::jsonb);

-- Permission back-fill (same technique as the earlier migrations: lift FORCE RLS for the statement, put it back).
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
UPDATE "roles" SET "permissions" = array_append("permissions", 'booking.view')
 WHERE NOT ('booking.view' = ANY("permissions"))
   AND "permissions" && ARRAY['quotation.manage', 'quotation.send', 'booking.create', 'booking.edit', 'booking.hold',
                              'booking.extend_hold', 'booking.confirm', 'booking.cancel', 'booking.edit_locked'];
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
