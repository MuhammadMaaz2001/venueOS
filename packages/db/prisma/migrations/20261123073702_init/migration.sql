-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "auth_token_purpose" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "space_kind" AS ENUM ('HALL', 'LAWN', 'MARQUEE', 'ROOFTOP', 'ROOM', 'FARMHOUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "slot_mode" AS ENUM ('FIXED', 'HOURLY', 'FULL_DAY');

-- CreateEnum
CREATE TYPE "add_on_pricing" AS ENUM ('FIXED', 'PER_HEAD', 'PER_HOUR', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "price_rule_kind" AS ENUM ('DAY_OF_WEEK', 'DATE_RANGE', 'SPECIFIC_DATE');

-- CreateEnum
CREATE TYPE "adjustment_kind" AS ENUM ('PERCENT', 'FIXED_AMOUNT', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "lead_stage" AS ENUM ('NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('DRAFT', 'TENTATIVE', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "line_item_kind" AS ENUM ('RENT', 'PACKAGE', 'ADD_ON', 'ADJUSTMENT', 'DISCOUNT', 'TAX');

-- CreateEnum
CREATE TYPE "payment_entry_type" AS ENUM ('RECEIPT', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'MOBILE_WALLET', 'ONLINE_GATEWAY');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'CLEARED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "refund_request_status" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "vendor_assignment_status" AS ENUM ('REQUESTED', 'CONFIRMED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('STAFF', 'RAW_MATERIAL', 'DECOR', 'VENDOR', 'UTILITIES', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "expense_entry_type" AS ENUM ('EXPENSE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "inventory_movement_type" AS ENUM ('PURCHASE', 'ISSUE', 'RETURN', 'DAMAGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('USER', 'SYSTEM', 'PLATFORM_ADMIN');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entitlements" JSONB NOT NULL,
    "price_monthly" DECIMAL(18,3) NOT NULL,
    "price_yearly" DECIMAL(18,3),
    "currency" CHAR(3) NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "custom_domain" TEXT,
    "country" CHAR(2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "status" "tenant_status" NOT NULL DEFAULT 'TRIAL',
    "trial_ends_at" TIMESTAMPTZ(6),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_counters" (
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_counters_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billing_cycle" TEXT NOT NULL,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "provider" TEXT,
    "provider_ref" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "name" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credentials" (
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "active_tenant_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" "auth_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "venue_ids" TEXT[],
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "ip" TEXT,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "venue_ids" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "timezone" TEXT,
    "opens_at" TEXT,
    "closes_at" TEXT,
    "local_rules" JSONB NOT NULL DEFAULT '{}',
    "photo_keys" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "space_kind" NOT NULL DEFAULT 'HALL',
    "capacity_seated" INTEGER,
    "capacity_standing" INTEGER,
    "min_guests" INTEGER,
    "is_combined" BOOLEAN NOT NULL DEFAULT false,
    "setup_buffer_min" INTEGER NOT NULL DEFAULT 0,
    "cleanup_buffer_min" INTEGER NOT NULL DEFAULT 0,
    "base_rent" DECIMAL(18,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_components" (
    "tenant_id" TEXT NOT NULL,
    "combined_space_id" TEXT NOT NULL,
    "component_space_id" TEXT NOT NULL,

    CONSTRAINT "space_components_pkey" PRIMARY KEY ("combined_space_id","component_space_id")
);

-- CreateTable
CREATE TABLE "slot_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "slot_mode" NOT NULL DEFAULT 'FIXED',
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "days_of_week" INTEGER[],
    "min_hours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slot_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_slot_prices" (
    "tenant_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "rent" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "space_slot_prices_pkey" PRIMARY KEY ("space_id","slot_id")
);

-- CreateTable
CREATE TABLE "event_types" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_package_id" TEXT,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "event_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "per_head_rate" DECIMAL(18,3) NOT NULL,
    "min_guests" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_items" (
    "tenant_id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "package_items_pkey" PRIMARY KEY ("package_id","menu_item_id")
);

-- CreateTable
CREATE TABLE "add_ons" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricing" "add_on_pricing" NOT NULL DEFAULT 'FIXED',
    "price" DECIMAL(18,3) NOT NULL,
    "vendor_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "price_rule_kind" NOT NULL,
    "space_id" TEXT,
    "slot_id" TEXT,
    "days_of_week" INTEGER[],
    "start_date" DATE,
    "end_date" DATE,
    "adjustment" "adjustment_kind" NOT NULL,
    "value" DECIMAL(18,3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_pct" DECIMAL(5,2) NOT NULL,
    "inclusive" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tiers" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_defs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "alt_phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "preferred_locale" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "event_type_id" TEXT,
    "preferred_date" DATE,
    "flexible_dates" BOOLEAN NOT NULL DEFAULT false,
    "guests" INTEGER,
    "budget" DECIMAL(18,3),
    "source" TEXT NOT NULL,
    "stage" "lead_stage" NOT NULL DEFAULT 'NEW',
    "lost_reason" TEXT,
    "assignee_id" TEXT,
    "next_follow_up_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "number" TEXT,
    "customer_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "status" "booking_status" NOT NULL DEFAULT 'DRAFT',
    "quote_version" INTEGER NOT NULL DEFAULT 1,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "hold_expires_at" TIMESTAMPTZ(6),
    "hold_extensions" INTEGER NOT NULL DEFAULT 0,
    "confirmed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "cancellation_policy_id" TEXT,
    "cancellation_snapshot" JSONB,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "paid_total" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "line_items" JSONB NOT NULL,
    "subtotal" DECIMAL(18,3) NOT NULL,
    "discount_total" DECIMAL(18,3) NOT NULL,
    "tax_total" DECIMAL(18,3) NOT NULL,
    "grand_total" DECIMAL(18,3) NOT NULL,
    "valid_until" DATE,
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "pdf_key" TEXT,
    "created_by_id" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "status" "session_status" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMPTZ(6),
    "slot_id" TEXT,
    "event_type_id" TEXT,
    "package_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "guests" INTEGER NOT NULL,
    "guaranteed_guests" INTEGER,
    "setup_notes" TEXT,
    "kitchen_notes" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_occupancies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "space_occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_line_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "session_id" TEXT,
    "kind" "line_item_kind" NOT NULL,
    "description" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(18,3) NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "booking_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedule_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "reminded" BOOLEAN NOT NULL DEFAULT false,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "entry_type" "payment_entry_type" NOT NULL DEFAULT 'RECEIPT',
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'CLEARED',
    "cleared_at" TIMESTAMPTZ(6),
    "reference" TEXT,
    "receipt_no" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_id" TEXT,
    "gateway_payload" JSONB,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "reverses_id" TEXT,
    "refund_request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "status" "refund_request_status" NOT NULL DEFAULT 'REQUESTED',
    "amount" DECIMAL(18,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "idempotency_key" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "commission_pct" DECIMAL(5,2),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" "vendor_assignment_status" NOT NULL DEFAULT 'REQUESTED',
    "arrival_time" TIMESTAMPTZ(6),
    "agreed_cost" DECIMAL(18,3),
    "commission_amount" DECIMAL(18,3),
    "commission_received" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vendor_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "session_id" TEXT,
    "vendor_id" TEXT,
    "entry_type" "expense_entry_type" NOT NULL DEFAULT 'EXPENSE',
    "category" "expense_category" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "method" "payment_method" NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "receipt_key" TEXT,
    "idempotency_key" TEXT,
    "reverses_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "unit_cost" DECIMAL(18,3),
    "reorder_level" INTEGER,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "session_id" TEXT,
    "type" "inventory_movement_type" NOT NULL,
    "stock_delta" INTEGER NOT NULL,
    "returned_qty" INTEGER,
    "damaged_qty" INTEGER,
    "unit_cost" DECIMAL(18,3),
    "expense_id" TEXT,
    "note" TEXT,
    "idempotency_key" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "message_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "event" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "status" TEXT NOT NULL,
    "provider_ref" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_type" "actor_type" NOT NULL DEFAULT 'USER',
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants"("custom_domain");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "login_attempts_email_hash_created_at_idx" ON "login_attempts"("email_hash", "created_at");

-- CreateIndex
CREATE INDEX "login_attempts_ip_created_at_idx" ON "login_attempts"("ip", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "roles"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "venues_tenant_id_idx" ON "venues"("tenant_id");

-- CreateIndex
CREATE INDEX "spaces_tenant_id_venue_id_idx" ON "spaces"("tenant_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_tenant_id_id_key" ON "spaces"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "space_components_tenant_id_idx" ON "space_components"("tenant_id");

-- CreateIndex
CREATE INDEX "slot_templates_tenant_id_venue_id_idx" ON "slot_templates"("tenant_id", "venue_id");

-- CreateIndex
CREATE INDEX "space_slot_prices_tenant_id_idx" ON "space_slot_prices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_types_tenant_id_name_key" ON "event_types"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "menu_items_tenant_id_idx" ON "menu_items"("tenant_id");

-- CreateIndex
CREATE INDEX "packages_tenant_id_idx" ON "packages"("tenant_id");

-- CreateIndex
CREATE INDEX "package_items_tenant_id_idx" ON "package_items"("tenant_id");

-- CreateIndex
CREATE INDEX "add_ons_tenant_id_idx" ON "add_ons"("tenant_id");

-- CreateIndex
CREATE INDEX "price_rules_tenant_id_idx" ON "price_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "tax_rates_tenant_id_idx" ON "tax_rates"("tenant_id");

-- CreateIndex
CREATE INDEX "cancellation_policies_tenant_id_idx" ON "cancellation_policies"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_tenant_id_entity_key_key" ON "custom_field_defs"("tenant_id", "entity", "key");

-- CreateIndex
CREATE INDEX "customers_tenant_id_phone_idx" ON "customers"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_id_key" ON "customers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_stage_idx" ON "leads"("tenant_id", "stage");

-- CreateIndex
CREATE INDEX "leads_tenant_id_next_follow_up_at_idx" ON "leads"("tenant_id", "next_follow_up_at");

-- CreateIndex
CREATE INDEX "leads_customer_id_idx" ON "leads"("customer_id");

-- CreateIndex
CREATE INDEX "bookings_tenant_id_status_idx" ON "bookings"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "bookings_customer_id_idx" ON "bookings"("customer_id");

-- CreateIndex
CREATE INDEX "bookings_lead_id_idx" ON "bookings"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_tenant_id_number_key" ON "bookings"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_tenant_id_id_key" ON "bookings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "quotations_tenant_id_booking_id_idx" ON "quotations"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_booking_id_version_key" ON "quotations"("booking_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_tenant_id_number_version_key" ON "quotations"("tenant_id", "number", "version");

-- CreateIndex
CREATE INDEX "booking_sessions_booking_id_idx" ON "booking_sessions"("booking_id");

-- CreateIndex
CREATE INDEX "booking_sessions_tenant_id_starts_at_idx" ON "booking_sessions"("tenant_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_sessions_tenant_id_id_key" ON "booking_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "space_occupancies_tenant_id_space_id_starts_at_idx" ON "space_occupancies"("tenant_id", "space_id", "starts_at");

-- CreateIndex
CREATE INDEX "space_occupancies_session_id_idx" ON "space_occupancies"("session_id");

-- CreateIndex
CREATE INDEX "booking_line_items_tenant_id_booking_id_idx" ON "booking_line_items"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "payment_schedule_items_tenant_id_due_date_idx" ON "payment_schedule_items"("tenant_id", "due_date");

-- CreateIndex
CREATE INDEX "payment_schedule_items_booking_id_idx" ON "payment_schedule_items"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reverses_id_key" ON "payments"("reverses_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_refund_request_id_key" ON "payments"("refund_request_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_booking_id_idx" ON "payments"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_receipt_no_key" ON "payments"("tenant_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_idempotency_key_key" ON "payments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "refund_requests_tenant_id_booking_id_idx" ON "refund_requests"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "refund_requests_tenant_id_status_idx" ON "refund_requests"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_tenant_id_idempotency_key_key" ON "refund_requests"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "vendors_tenant_id_idx" ON "vendors"("tenant_id");

-- CreateIndex
CREATE INDEX "vendor_assignments_tenant_id_session_id_idx" ON "vendor_assignments"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "vendor_assignments_tenant_id_vendor_id_idx" ON "vendor_assignments"("tenant_id", "vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_reverses_id_key" ON "expenses"("reverses_id");

-- CreateIndex
CREATE INDEX "expenses_tenant_id_booking_id_idx" ON "expenses"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "expenses_tenant_id_paid_at_idx" ON "expenses"("tenant_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenant_id_idempotency_key_key" ON "expenses"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_items_tenant_id_idx" ON "inventory_items"("tenant_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_item_id_idx" ON "inventory_movements"("tenant_id", "item_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_session_id_idx" ON "inventory_movements"("tenant_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_tenant_id_idempotency_key_key" ON "inventory_movements"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_event_channel_locale_key" ON "message_templates"("tenant_id", "event", "channel", "locale");

-- CreateIndex
CREATE INDEX "message_logs_tenant_id_created_at_idx" ON "message_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "message_logs_tenant_id_message_key_idx" ON "message_logs"("tenant_id", "message_key");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_tenant_id_fkey" FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_components" ADD CONSTRAINT "space_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_components" ADD CONSTRAINT "space_components_combined_space_id_fkey" FOREIGN KEY ("combined_space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_components" ADD CONSTRAINT "space_components_component_space_id_fkey" FOREIGN KEY ("component_space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_templates" ADD CONSTRAINT "slot_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_templates" ADD CONSTRAINT "slot_templates_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_slot_prices" ADD CONSTRAINT "space_slot_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_slot_prices" ADD CONSTRAINT "space_slot_prices_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_slot_prices" ADD CONSTRAINT "space_slot_prices_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slot_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_default_package_id_fkey" FOREIGN KEY ("default_package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slot_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancellation_policy_id_fkey" FOREIGN KEY ("cancellation_policy_id") REFERENCES "cancellation_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "bookings"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "bookings"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_tenant_id_space_id_fkey" FOREIGN KEY ("tenant_id", "space_id") REFERENCES "spaces"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slot_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_occupancies" ADD CONSTRAINT "space_occupancies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_occupancies" ADD CONSTRAINT "space_occupancies_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "booking_sessions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_occupancies" ADD CONSTRAINT "space_occupancies_tenant_id_space_id_fkey" FOREIGN KEY ("tenant_id", "space_id") REFERENCES "spaces"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_line_items" ADD CONSTRAINT "booking_line_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_line_items" ADD CONSTRAINT "booking_line_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_line_items" ADD CONSTRAINT "booking_line_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "booking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "bookings"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_request_id_fkey" FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "booking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_assignments" ADD CONSTRAINT "vendor_assignments_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "booking_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "booking_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Appended by hand from prisma/sql/001_constraints_and_rls.sql (docs/03-data-model.md):
-- constraints, triggers, Row Level Security and role grants Prisma cannot express.
-- Runs as venueos_migrator. Never edit this migration after it is applied anywhere;
-- later changes go in a NEW migration.
-- ════════════════════════════════════════════════════════════════════════════

-- venueOS: constraints, triggers, Row Level Security and role grants that Prisma cannot express.
--
-- HOW TO USE
--   Append this file to the FIRST migration (prisma migrate dev --create-only, then paste it below
--   the generated DDL). It runs as venueos_migrator, the owner of the schema.
--
-- PRECONDITIONS (cluster-level, created by packages/db/docker/init-roles.sql locally and by
-- infrastructure code elsewhere; see docs/04-security.md §3 and docs/08-deployment-and-ops.md):
--   venueos_migrator  owns the database and schema, runs migrations, is a member of venueos_definer
--   venueos_definer   NOLOGIN BYPASSRLS; owns SECURITY DEFINER functions (resolve_tenant)
--   venueos_app       LOGIN, no BYPASSRLS; api and worker tenant work
--   venueos_auth      LOGIN, no BYPASSRLS; used only by the API's AuthModule
--   venueos_jobs      LOGIN, BYPASSRLS; worker scanners (SELECT on a few tables only)
--
-- Every column is snake_case (see docs/03-data-model.md). Tables carrying tenant_id get forced RLS.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────────── 0) Helpers ─────────────────────────────
-- Context set by TenantDb in every transaction:
--   SELECT set_config('app.tenant_id', '<tenant id>', true);
--   SELECT set_config('app.user_id',   '<user id>',   true);
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

-- Call in the migration of EVERY new table that has tenant_id. The test suite fails if one is missed.
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

-- updated_at / rev bookkeeping. rev is the optimistic-concurrency token (API: 409 VERSION_CONFLICT).
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSE
    NEW.rev := OLD.rev + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enable_rev_trigger(t regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS touch_row ON %s', t);
  EXECUTE format(
    'CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
END $fn$;

-- Privilege classes (docs/03-data-model.md "Privilege classes"):
--   append-only: venueos_app may INSERT/SELECT only (optionally UPDATE of listed columns)
CREATE OR REPLACE FUNCTION make_append_only(t regclass, updatable_cols text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM venueos_app', t);
  IF array_length(updatable_cols, 1) IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%s) ON %s TO venueos_app',
                   (SELECT string_agg(quote_ident(c), ', ') FROM unnest(updatable_cols) c), t);
  END IF;
END $fn$;

--   no-delete: rows are never deleted by the app (soft states instead)
CREATE OR REPLACE FUNCTION revoke_delete(t regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM venueos_app', t);
END $fn$;

--   auth-only: invisible to venueos_app; only venueos_auth (the API's AuthModule) can use them.
--   Tables that also carry tenant_id need a policy for venueos_auth, because invitations are
--   looked up by token before any tenant context exists.
CREATE OR REPLACE FUNCTION restrict_to_auth(t regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE has_tenant boolean;
BEGIN
  EXECUTE format('REVOKE ALL ON %s FROM venueos_app', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO venueos_auth', t);
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = t AND attname = 'tenant_id' AND NOT attisdropped)
    INTO has_tenant;
  IF has_tenant THEN
    EXECUTE format('DROP POLICY IF EXISTS auth_all ON %s', t);
    EXECUTE format('CREATE POLICY auth_all ON %s TO venueos_auth USING (true) WITH CHECK (true)', t);
  END IF;
END $fn$;

-- Helpers are for migrations only.
REVOKE EXECUTE ON FUNCTION enable_tenant_rls(regclass), enable_rev_trigger(regclass),
  make_append_only(regclass, text[]), revoke_delete(regclass), restrict_to_auth(regclass) FROM PUBLIC;

-- ───────────────────────────── 1) rev / updated_at triggers ─────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT format('%I.%I', c.table_schema, c.table_name)
      FROM information_schema.columns c
      JOIN information_schema.columns u
        ON u.table_schema = c.table_schema AND u.table_name = c.table_name AND u.column_name = 'updated_at'
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'rev' AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM enable_rev_trigger(t::regclass);
  END LOOP;
END $$;

-- ───────────────────────────── 2) CHECK constraints ─────────────────────────────
-- A booking gets its number when first held (docs/05 §13); DRAFT and a cancelled draft have none.
ALTER TABLE bookings ADD CONSTRAINT bookings_number_required
  CHECK (status NOT IN ('TENTATIVE', 'CONFIRMED', 'COMPLETED', 'EXPIRED') OR number IS NOT NULL);

ALTER TABLE booking_sessions ADD CONSTRAINT booking_sessions_valid_range CHECK (ends_at > starts_at);

-- Payments: amount is always positive; entry_type decides the sign. A REVERSAL must point at
-- the entry it negates (one reversal per entry: unique reverses_id); only REFUNDs link to a request.
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);
ALTER TABLE payments ADD CONSTRAINT payments_reversal_link
  CHECK ((entry_type = 'REVERSAL') = (reverses_id IS NOT NULL));
ALTER TABLE payments ADD CONSTRAINT payments_refund_link
  CHECK (refund_request_id IS NULL OR entry_type = 'REFUND');

-- Only cheques have a clearing lifecycle: every other method is CLEARED on entry and stays so.
ALTER TABLE payments ADD CONSTRAINT payments_status_by_method
  CHECK (method = 'CHEQUE' OR status = 'CLEARED');

-- Line items are signed (docs/05 §3): DISCOUNT <= 0, ADJUSTMENT either sign, everything else >= 0.
-- A booking's totals are SUM(amount) over its current line items.
ALTER TABLE booking_line_items ADD CONSTRAINT booking_line_items_amount_sign CHECK (
  CASE kind
    WHEN 'DISCOUNT'   THEN amount <= 0
    WHEN 'ADJUSTMENT' THEN true
    ELSE amount >= 0
  END);

ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_amount_positive CHECK (amount > 0);

ALTER TABLE expenses ADD CONSTRAINT expenses_amount_positive CHECK (amount > 0);
ALTER TABLE expenses ADD CONSTRAINT expenses_reversal_link
  CHECK ((entry_type = 'REVERSAL') = (reverses_id IS NOT NULL));

-- Stock can never go negative; the API takes SELECT ... FOR UPDATE on the item first and maps
-- the violation to 422 INSUFFICIENT_STOCK.
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_on_hand_nonneg CHECK (on_hand >= 0);

ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_shape CHECK (
  CASE type
    WHEN 'PURCHASE'   THEN stock_delta > 0 AND returned_qty IS NULL AND damaged_qty IS NULL
    WHEN 'ISSUE'      THEN stock_delta < 0 AND session_id IS NOT NULL
                           AND returned_qty IS NULL AND damaged_qty IS NULL
    WHEN 'RETURN'     THEN session_id IS NOT NULL
                           AND returned_qty IS NOT NULL AND damaged_qty IS NOT NULL
                           AND returned_qty >= 0 AND damaged_qty >= 0
                           AND returned_qty + damaged_qty > 0
                           AND stock_delta = returned_qty
    WHEN 'DAMAGE'     THEN stock_delta < 0 AND returned_qty IS NULL AND damaged_qty IS NULL
    WHEN 'ADJUSTMENT' THEN stock_delta <> 0 AND returned_qty IS NULL AND damaged_qty IS NULL
  END);
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_expense_only_purchase
  CHECK (expense_id IS NULL OR type = 'PURCHASE');

-- ───────────────────────────── 3) Double-booking prevention ─────────────────────────────
-- Two ACTIVE occupancy rows for the same physical space may never overlap.
-- '[)' = end-exclusive, so 16:00-19:00 and 19:00-23:00 can sit back to back.
ALTER TABLE space_occupancies
  ADD CONSTRAINT space_occupancies_valid_range CHECK (ends_at > starts_at);

ALTER TABLE space_occupancies
  ADD CONSTRAINT space_occupancies_no_overlap
  EXCLUDE USING gist (
    space_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (active);

-- ───────────────────────────── 4) Occupancy follows booking and session status ─────────────────────────────
-- active = booking is TENTATIVE/CONFIRMED/COMPLETED AND the session is ACTIVE.
-- DRAFT (quotation), CANCELLED and EXPIRED bookings never block; a cancelled session never blocks.
-- Re-activating fails with the exclusion error if someone else has taken the slot meanwhile.

-- New occupancy rows derive `active` themselves; whatever the app writes is overwritten.
CREATE OR REPLACE FUNCTION occupancy_set_active_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT (b.status IN ('TENTATIVE', 'CONFIRMED', 'COMPLETED') AND s.status = 'ACTIVE')
    INTO NEW.active
    FROM booking_sessions s
    JOIN bookings b ON b.id = s.booking_id AND b.tenant_id = s.tenant_id
   WHERE s.id = NEW.session_id AND s.tenant_id = NEW.tenant_id;
  NEW.active := COALESCE(NEW.active, false);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS space_occupancies_set_active ON space_occupancies;
CREATE TRIGGER space_occupancies_set_active
  BEFORE INSERT ON space_occupancies
  FOR EACH ROW EXECUTE FUNCTION occupancy_set_active_on_insert();

-- Booking status changes flip every occupancy of the booking.
CREATE OR REPLACE FUNCTION sync_occupancy_from_booking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE space_occupancies o
       SET active = (NEW.status IN ('TENTATIVE', 'CONFIRMED', 'COMPLETED') AND s.status = 'ACTIVE')
      FROM booking_sessions s
     WHERE o.session_id = s.id AND o.tenant_id = s.tenant_id
       AND s.booking_id = NEW.id AND s.tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bookings_sync_occupancy ON bookings;
CREATE TRIGGER bookings_sync_occupancy
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_occupancy_from_booking();

-- Soft-cancelling (or restoring) one session flips only that session's occupancy.
CREATE OR REPLACE FUNCTION sync_occupancy_from_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE space_occupancies o
       SET active = (NEW.status = 'ACTIVE' AND b.status IN ('TENTATIVE', 'CONFIRMED', 'COMPLETED'))
      FROM bookings b
     WHERE b.id = NEW.booking_id AND b.tenant_id = NEW.tenant_id
       AND o.session_id = NEW.id AND o.tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS booking_sessions_sync_occupancy ON booking_sessions;
CREATE TRIGGER booking_sessions_sync_occupancy
  AFTER UPDATE OF status ON booking_sessions
  FOR EACH ROW EXECUTE FUNCTION sync_occupancy_from_session();

-- ───────────────────────────── 5) Combined spaces ─────────────────────────────
-- A combined space is made of physical spaces of the same venue; combined spaces never nest.
CREATE OR REPLACE FUNCTION validate_space_component() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c spaces%ROWTYPE; p spaces%ROWTYPE;
BEGIN
  SELECT * INTO c FROM spaces WHERE id = NEW.combined_space_id;
  SELECT * INTO p FROM spaces WHERE id = NEW.component_space_id;
  IF c.id IS NULL OR p.id IS NULL THEN
    RAISE EXCEPTION 'space_components_not_found' USING ERRCODE = '23503';
  END IF;
  IF c.tenant_id <> NEW.tenant_id OR p.tenant_id <> NEW.tenant_id OR c.venue_id <> p.venue_id THEN
    RAISE EXCEPTION 'space_components_same_venue' USING ERRCODE = '23514';
  END IF;
  IF NOT c.is_combined THEN
    RAISE EXCEPTION 'space_components_parent_not_combined' USING ERRCODE = '23514';
  END IF;
  IF p.is_combined THEN
    RAISE EXCEPTION 'space_components_no_nesting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS space_components_validate ON space_components;
CREATE TRIGGER space_components_validate
  BEFORE INSERT OR UPDATE ON space_components
  FOR EACH ROW EXECUTE FUNCTION validate_space_component();

-- Flipping is_combined must not break existing component links.
CREATE OR REPLACE FUNCTION validate_space_combined_flag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_combined AND EXISTS (
       SELECT 1 FROM space_components WHERE component_space_id = NEW.id) THEN
    RAISE EXCEPTION 'space_components_no_nesting' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_combined AND EXISTS (
       SELECT 1 FROM space_components WHERE combined_space_id = NEW.id) THEN
    RAISE EXCEPTION 'space_components_parent_not_combined' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS spaces_validate_combined_flag ON spaces;
CREATE TRIGGER spaces_validate_combined_flag
  BEFORE UPDATE OF is_combined ON spaces
  FOR EACH ROW EXECUTE FUNCTION validate_space_combined_flag();

-- ───────────────────────────── 6) Tenant isolation (Row Level Security) ─────────────────────────────
-- Without app.tenant_id, tenant tables return no rows and reject writes. Cross-tenant jobs
-- connect as venueos_jobs (BYPASSRLS); venueos_app must NOT have it.
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

-- Before a tenant is chosen (login, tenant switcher) only app.user_id is set. This policy is
-- OR-ed with tenant_isolation: a user sees their own memberships in any tenant, nothing else.
DROP POLICY IF EXISTS membership_self ON memberships;
CREATE POLICY membership_self ON memberships
  FOR SELECT USING (user_id = app_current_user());

-- Tenants (no tenant_id column): visible when it is the active tenant or the user is a member.
-- Signup inserts a tenant after pre-generating its id and setting app.tenant_id to it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON tenants;
CREATE POLICY tenant_visible ON tenants
  USING (
    id = app_current_tenant()
    OR EXISTS (SELECT 1 FROM memberships m
                WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user())
  );

-- Users (global table): your own row, or users with a membership in the current tenant.
-- The auth role (AuthModule) manages all users: login, signup, invitations, reset.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_visible ON users;
CREATE POLICY users_visible ON users
  USING (
    id = app_current_user()
    OR EXISTS (SELECT 1 FROM memberships m
                WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant())
  );
DROP POLICY IF EXISTS users_auth_all ON users;
CREATE POLICY users_auth_all ON users TO venueos_auth USING (true) WITH CHECK (true);

-- ───────────────────────────── 7) Public pages: resolve_tenant ─────────────────────────────
-- Public pages (subdomain -> tenant) run before anyone logs in. This is the ONLY way to read
-- tenants without context; it returns the id and nothing else. Because tenants has FORCE RLS,
-- the function must be owned by a role with BYPASSRLS (venueos_definer), not by the migrator.
CREATE OR REPLACE FUNCTION resolve_tenant(p_host_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM tenants
   WHERE (slug = p_host_slug OR custom_domain = p_host_slug)
     AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
$$;

GRANT USAGE ON SCHEMA public TO venueos_definer;
GRANT SELECT ON tenants TO venueos_definer;
GRANT CREATE ON SCHEMA public TO venueos_definer;   -- needed only for ALTER ... OWNER TO
ALTER FUNCTION resolve_tenant(text) OWNER TO venueos_definer;
REVOKE CREATE ON SCHEMA public FROM venueos_definer;
REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO venueos_app, venueos_auth;

-- ───────────────────────────── 8) Role grants ─────────────────────────────
GRANT USAGE ON SCHEMA public TO venueos_app, venueos_auth, venueos_jobs;

-- Baseline: venueos_app gets DML on every table except Prisma's bookkeeping table...
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO venueos_app', t);
  END LOOP;
END $$;
-- ...and so do tables created by future migrations. Their migration then narrows the class
-- with make_append_only / revoke_delete / restrict_to_auth where needed (docs/03 checklist).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO venueos_app;

-- Plans are platform data: read-only for the app (seed/ops manage them as the migrator).
REVOKE INSERT, UPDATE, DELETE ON plans FROM venueos_app;

-- Append-only ledgers (CLAUDE.md rule 6). Payments: only cheque clearing may update a row.
SELECT make_append_only('payments', ARRAY['status', 'cleared_at']);
SELECT make_append_only('expenses');
SELECT make_append_only('inventory_movements');
SELECT make_append_only('audit_logs');
SELECT make_append_only('message_logs');

-- Never deleted by the app (cancel/expire/deactivate instead).
SELECT revoke_delete('tenants');
SELECT revoke_delete('users');
SELECT revoke_delete('bookings');
SELECT revoke_delete('booking_sessions');
SELECT revoke_delete('quotations');
SELECT revoke_delete('refund_requests');

-- Auth tables: readable only through venueos_auth (the API's AuthModule).
SELECT restrict_to_auth('user_credentials');
SELECT restrict_to_auth('auth_sessions');
SELECT restrict_to_auth('auth_tokens');
SELECT restrict_to_auth('invitations');
SELECT restrict_to_auth('login_attempts');
GRANT SELECT, INSERT, UPDATE ON users TO venueos_auth;   -- no DELETE; policy users_auth_all applies

-- Worker scanners: SELECT only, on the tables needed to FIND due work (they read ids and enqueue
-- one job per item; the job itself runs as venueos_app inside the tenant context).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM venueos_jobs;
GRANT SELECT ON tenants, venues, bookings, booking_sessions, payment_schedule_items,
                leads, inventory_items TO venueos_jobs;
-- (pg-boss schema grants for venueos_app and venueos_jobs are added with the worker, task P0-6.)
