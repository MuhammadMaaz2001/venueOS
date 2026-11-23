-- P0-4 Auth.
--
--   1. auth_requests: one row per request to a public endpoint that sends an email (signup,
--      resend-verification, password/forgot). It backs the abuse limits (3 emails per email hash per hour,
--      20 requests per IP per 15 minutes), kept in the database so they hold across API instances.
--      Auth-only table: venueos_app cannot read it, venueos_auth has full DML.
--   2. At most one pending (not accepted, not revoked) invitation per tenant and email.

-- CreateTable
CREATE TABLE "auth_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_requests_email_hash_created_at_idx" ON "auth_requests"("email_hash", "created_at");

-- CreateIndex
CREATE INDEX "auth_requests_ip_created_at_idx" ON "auth_requests"("ip", "created_at");

-- Privilege class (docs/03-data-model.md): invisible to venueos_app, full DML for venueos_auth.
SELECT restrict_to_auth('auth_requests');

-- One pending invitation per tenant and email. Expired-but-unrevoked rows still count: the API revokes an
-- expired invitation before it issues a new one.
CREATE UNIQUE INDEX "invitations_pending_email_key"
  ON "invitations" ("tenant_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
