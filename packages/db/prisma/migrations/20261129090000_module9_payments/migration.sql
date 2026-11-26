-- Module 9: payments and receipts.
--
-- 1) receipt_files: where the receipt PDF of a payment lives. `payments` is append-only (only `status` and `cleared_at` may be
--    updated), so the key of the PDF cannot be a column of it; the worker writes this row when it has rendered the receipt.
-- 2) bookings: `paid_total` is derived from the ledger in the transaction that changes a payment. Like `hold_warned_at`, it must
--    not bump `rev` / `updated_at`, or the booking somebody has open would go stale (409 VERSION_CONFLICT) because of a payment.
-- 3) CHECKs: a schedule amount is positive; a RECEIPT has a receipt number and nothing else has one; a refund request that was
--    decided names the person who decided it, and the two-person rule is the database's too (the approver is another user than
--    the requester unless `self_approved`).
-- 4) Indexes for the reminder scanner and the lists.
-- 5) Queues of the payment-due reminder: scanner `reminders.payment-due`, per item `reminders.payment-due.run`.
-- 6) Back-fill: a role that holds any payment permission also holds `payment.view` (the pages need it).

CREATE TABLE "receipt_files" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "pdf_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "receipt_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_files_payment_id_key" ON "receipt_files"("payment_id");
CREATE INDEX "receipt_files_tenant_id_idx" ON "receipt_files"("tenant_id");

ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT enable_tenant_rls('receipt_files');

CREATE OR REPLACE FUNCTION touch_row_bookings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSIF (to_jsonb(NEW) - 'hold_warned_at' - 'paid_total' - 'rev' - 'updated_at')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'hold_warned_at' - 'paid_total' - 'rev' - 'updated_at') THEN
    NEW.rev := OLD.rev;
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.rev := OLD.rev + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_label_not_blank" CHECK (length(btrim("label")) > 0);

ALTER TABLE "payments" ADD CONSTRAINT "payments_receipt_no_by_type" CHECK (("entry_type" = 'RECEIPT') = ("receipt_no" IS NOT NULL));

ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_decision_consistent"
  CHECK (("status" = 'REQUESTED') = ("approved_by_id" IS NULL));
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_two_person_rule"
  CHECK ("approved_by_id" IS NULL OR (("approved_by_id" = "requested_by_id") = "self_approved"));

-- The reminder scanner reads items that were not reminded yet; the receivables list reads a booking's items by due date.
CREATE INDEX "payment_schedule_items_unreminded_idx" ON "payment_schedule_items" ("due_date") WHERE NOT "reminded";
CREATE INDEX "payment_schedule_items_booking_due_idx" ON "payment_schedule_items" ("booking_id", "due_date");
CREATE INDEX "payments_tenant_id_received_at_idx" ON "payments" ("tenant_id", "received_at");

SELECT pgboss.create_queue('reminders.payment-due.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('reminders.payment-due', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":900,"deadLetter":"reminders.payment-due.dead"}'::jsonb);
SELECT pgboss.create_queue('reminders.payment-due.run.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('reminders.payment-due.run', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":300,"deadLetter":"reminders.payment-due.run.dead"}'::jsonb);

-- Permission back-fill (lift FORCE RLS for the statement, put it back; same technique as the earlier migrations).
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
UPDATE "roles" SET "permissions" = array_append("permissions", 'payment.view')
 WHERE NOT ('payment.view' = ANY("permissions"))
   AND "permissions" && ARRAY['payment.record', 'payment.reverse', 'payment.refund.request', 'payment.refund.approve'];
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
