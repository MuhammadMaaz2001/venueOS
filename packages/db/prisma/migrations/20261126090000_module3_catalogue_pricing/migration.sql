-- Module 3 (catalogue and pricing).
--
-- 1) Soft delete (`active`) for the three catalogue tables that had none: tax rates, cancellation policies, custom
--    field definitions (docs/03: catalogue rows are deactivated, never deleted; bookings reference policies).
-- 2) At most one default tax rate and one default cancellation policy per tenant, and a default is always active.
-- 3) Names are unique among ACTIVE rows, case-insensitive (menu items, packages, add-ons, tax rates, policies). The
--    services check first and answer 409 DUPLICATE; these indexes are the backstop for a race.
-- 4) Sanity CHECKs on the money / percentage / quantity columns and on the price rule date range.
-- 5) The new permissions `catalogue.view` and `pricing.view` (docs/04): existing roles are back-filled so nobody who
--    could manage an area loses sight of it, and the default roles get the views of docs/01.

ALTER TABLE "tax_rates" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cancellation_policies" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "custom_field_defs" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "tax_rates_one_default_key" ON "tax_rates"("tenant_id") WHERE "is_default";
CREATE UNIQUE INDEX "cancellation_policies_one_default_key" ON "cancellation_policies"("tenant_id") WHERE "is_default";
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_default_is_active" CHECK (NOT "is_default" OR "active");
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_default_is_active" CHECK (NOT "is_default" OR "active");

CREATE UNIQUE INDEX "menu_items_active_name_key" ON "menu_items"("tenant_id", lower("name")) WHERE "active";
CREATE UNIQUE INDEX "packages_active_name_key" ON "packages"("tenant_id", lower("name")) WHERE "active";
CREATE UNIQUE INDEX "add_ons_active_name_key" ON "add_ons"("tenant_id", lower("name")) WHERE "active";
CREATE UNIQUE INDEX "tax_rates_active_name_key" ON "tax_rates"("tenant_id", lower("name")) WHERE "active";
CREATE UNIQUE INDEX "cancellation_policies_active_name_key" ON "cancellation_policies"("tenant_id", lower("name")) WHERE "active";

ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_rate_pct_range" CHECK ("rate_pct" >= 0 AND "rate_pct" <= 100);
ALTER TABLE "packages" ADD CONSTRAINT "packages_per_head_rate_nonneg" CHECK ("per_head_rate" >= 0);
ALTER TABLE "packages" ADD CONSTRAINT "packages_min_guests_nonneg" CHECK ("min_guests" >= 0);
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_quantity_positive" CHECK ("quantity" >= 1);
ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_price_nonneg" CHECK ("price" >= 0);
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_date_order" CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");

-- Back-fill the new permissions. The owner of `roles` is subject to FORCE ROW LEVEL SECURITY, so lift it for the
-- statements (same transaction) and put it back, as module 2's migration did for audit_logs.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

UPDATE "roles" SET "permissions" = array_append("permissions", 'catalogue.view')
 WHERE 'catalogue.manage' = ANY("permissions") AND NOT ('catalogue.view' = ANY("permissions"));
UPDATE "roles" SET "permissions" = array_append("permissions", 'pricing.view')
 WHERE 'pricing.manage' = ANY("permissions") AND NOT ('pricing.view' = ANY("permissions"));

UPDATE "roles" SET "permissions" = array_append("permissions", 'catalogue.view')
 WHERE "is_system" AND "name" IN ('Sales agent', 'Accountant', 'Operations') AND NOT ('catalogue.view' = ANY("permissions"));
UPDATE "roles" SET "permissions" = array_append("permissions", 'pricing.view')
 WHERE "is_system" AND "name" IN ('Sales agent', 'Accountant') AND NOT ('pricing.view' = ANY("permissions"));

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
