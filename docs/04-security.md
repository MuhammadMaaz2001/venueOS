# 04 — Security

These rules are mandatory. A change that breaks one of them is not mergeable, however urgent.

## What we protect and from whom

| Asset | Main threats |
| --- | --- |
| Tenant data (customers, bookings, revenue) | Another tenant reading it (IDOR, missing filter), a staff member exceeding their role |
| Money records | Silent edits or deletes, double-posting, inflated discounts |
| Customer PII (names, phones, CNIC, addresses) | Leaks through logs, exports, URLs, backups |
| Accounts | Credential stuffing, session theft, password reset abuse |
| Platform | Abuse of support access, leaked secrets, vulnerable dependencies |

## 1. Authentication

- Login with email + password in MVP (phone OTP later). Passwords hashed with **argon2id**
  (memory ≥ 19 MiB, iterations ≥ 2). Minimum 10 characters; reject the top 10k breached
  passwords list. No other complexity rules.
- **Sessions are server-side.** The cookie `__Host-vos_session` holds a 32-byte random token;
  the database stores only its SHA-256 hash (`auth_sessions.tokenHash`).
  Cookie flags: `HttpOnly; Secure; SameSite=Lax; Path=/` (no `Domain`, host-only).
- Session lifetime: 12 h idle timeout, 30 days absolute. Rotate the token on login and on
  tenant switch. Logout revokes the row. "Log out everywhere" revokes all of a user's rows.
  Password change or reset revokes all other sessions.
- **Brute force:** 5 failed logins per email per 15 min → 15 min lock (`lockedUntil`); 20
  attempts per IP per 15 min → 429. Same generic message for wrong email or wrong password.
- **One-time tokens** (email verify, password reset, invite): 32 random bytes, stored hashed in
  `auth_tokens`, single use, expiry 30 min (reset) / 72 h (invite). Reset request always answers
  "if the account exists, we sent an email".
- Mobile/public API (later): short-lived access tokens + rotating refresh tokens on
  `api.venueos.app`; never cookies there.

## 2. Authorization

- Permissions are strings like `booking.confirm`, defined once in
  `packages/shared/src/permissions.ts`. Roles are sets of permissions plus limits
  (`maxDiscountPct`). Default roles are seeded; tenants may copy and edit them.
- Every controller method has `@RequirePermission(...)` or `@Public()`. A test scans all routes
  and fails if any has neither.
- Venue scoping: a membership with `venueIds` set may only touch data of those venues. Services
  filter by `venueIds` from CLS; list endpoints never trust a `venueId` query param alone.
- Value limits are checked on the server: discount above the role limit → 403
  `DISCOUNT_LIMIT`; confirming without the required advance → 422 unless the user has
  `booking.confirm_override` (audited with a reason).
- Refunds need `payment.refund.approve`, and the approver may not be the person who
  requested the refund.

**MVP permission list** (source of truth: `packages/shared/src/permissions.ts`; keep in sync):

| Area | Permissions |
| --- | --- |
| Tenant | `tenant.settings.manage`, `billing.manage`, `staff.manage`, `role.manage`, `audit.view`, `template.manage` |
| Setup | `venue.manage`, `catalogue.manage`, `pricing.manage` |
| CRM | `customer.view`, `customer.manage`, `customer.view_sensitive`, `lead.view`, `lead.manage` |
| Bookings | `quotation.manage`, `booking.view`, `booking.view_prices`, `booking.hold`, `booking.extend_hold`, `booking.confirm`, `booking.confirm_override`, `booking.cancel`, `booking.edit_locked`, `booking.override_rules` |
| Money | `payment.view`, `payment.record`, `payment.reverse`, `payment.refund.request`, `payment.refund.approve` |
| Operations | `eventsheet.view`, `vendor.view`, `vendor.manage`, `expense.view`, `expense.record`, `expense.edit_locked`, `inventory.view`, `inventory.record`, `inventory.adjust` |
| Reports | `report.view`, `report.financial` |

## 3. Tenant isolation (three layers)

1. **Guard layer:** `TenantGuard` sets `tenantId` from the session's active tenant after
   checking the membership. Request bodies and query strings never carry `tenantId`.
2. **Client layer:** feature code only uses `TenantDb.tx()`, which sets `app.tenant_id` and
   `app.user_id` with `set_config(..., true)` (transaction-local, safe with connection pools).
   Lint rule: importing `@prisma/client` outside `packages/db` fails the build.
3. **Database layer:** forced RLS on every `tenant_id` table. The app connects as
   `venueos_app` (no `BYPASSRLS`, not the table owner). A forgotten filter returns nothing
   instead of another tenant's data.

Cross-tenant work (job scanners, platform admin) uses `venueos_jobs` only to find IDs, then
processes each item inside that tenant's context. Resource IDs from another tenant return
**404**, never 403 (do not confirm existence).

## 4. Input, output and injection

- Zod validation on every param, query and body; unknown keys stripped. Max lengths on all
  strings, max array sizes, numeric ranges (guests 1–100000, percentages 0–100).
- Prisma parameterizes queries. Raw SQL only via `Prisma.sql` tagged templates, never string
  concatenation. No `$queryRawUnsafe`.
- React escapes output by default; `dangerouslySetInnerHTML` is banned (lint rule).
- Email/PDF templates escape every variable (`{{ }}` escapes; triple-stash is banned). Tenant
  template bodies are text with placeholders, not raw HTML.
- CSV/Excel exports: prefix cells starting with `= + - @` with `'` to stop formula injection.

## 5. Web security

- CSRF: same-origin `/api` rewrite + `SameSite=Lax` cookie, and every state-changing request
  must send `X-Requested-With: venueos`; the API rejects it otherwise and checks the `Origin`
  header against the allowlist.
- Security headers (helmet on API, Next.js headers on web): HSTS (1 year, includeSubDomains),
  CSP with nonces (no `unsafe-inline` scripts), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`,
  `Permissions-Policy` with camera/mic/geolocation off.
- CORS: disabled for the web app (same origin). `api.venueos.app` uses an explicit allowlist.
- Rate limits: `@nestjs/throttler` in memory per API instance for general traffic (300 req/min
  per user). Login, password reset and invite limits are enforced in the database
  (`failedLoginCount`, `lockedUntil`, token issue counts) so they hold across instances. No
  Redis in the MVP.

## 6. Personal and sensitive data

- Collect the minimum. CNIC and similar values are only stored when the tenant defines a
  custom field marked `sensitive`; such values are encrypted by the API with AES-256-GCM
  (key from the secret store, key ID stored with the value) and shown masked (`*****-*****67-1`)
  unless the user has `customer.view_sensitive` (audited).
- Never put PII in URLs, logs, analytics events, error messages or Sentry. The pino redaction
  list covers `password`, `token`, `cookie`, `authorization`, `cnic`, `phone`, `email`, `body`.
- Files: private S3 bucket, server-side encryption, keys `tenants/{tenantId}/...`, uploads via
  pre-signed PUT with content-type and size limits (images/PDF ≤ 10 MB), downloads via pre-signed
  GET valid 5 minutes. The API checks the tenant before signing.
- Tenant offboarding: export on request (CSV + PDFs), data deleted 90 days after cancellation,
  backups age out per the retention policy.

## 7. Money integrity

- Prices are computed on the server; the client never sends amounts for line items.
- Payments, expenses and inventory movements are append-only. Corrections are reversing
  entries linked to the original.
- Payment create requires an `Idempotency-Key` header; the unique
  `(tenant_id, idempotencyKey)` makes retries safe.
- Booking and receipt numbers come from `tenant_counters` inside the same transaction
  (no gaps from rollbacks visible to users, no duplicates).
- `paidTotal` and `grandTotal` are recalculated in the transaction that changes payments or
  line items, never patched directly.

## 8. Audit

`audit_logs` records actor, action, entity, before/after (sensitive fields masked), IP and time
for: booking status changes, price/discount changes, payments, refunds, reversals, expenses,
inventory adjustments, role/permission changes, user invites/removals, settings changes,
sensitive-field views, platform-admin access. Audit rows are written in the same transaction
as the change and are never updated or deleted by the app.

## 9. Platform admin and support access

- Separate app (`admin.venueos.app`), separate login, mandatory TOTP 2FA, IP allowlist.
- Support access to a tenant ("impersonation") is read-only by default, requires a reason,
  expires after 60 minutes, shows a banner to the admin, and writes an audit row visible to the
  tenant owner.

## 10. Secrets, infrastructure and dependencies

- Secrets live in AWS Secrets Manager / SSM Parameter Store, injected as environment variables.
  `.env` files are git-ignored; only `.env.example` with fake values is committed.
- Separate AWS accounts or at least separate credentials and databases for staging and
  production. Production data is never copied to staging or developer machines.
- Database not publicly reachable; TLS required; app role has DML only.
- CI runs `pnpm audit --prod`, secret scanning (gitleaks) and dependency updates
  (Renovate/Dependabot). Lockfile is committed; no `latest` versions.
- Backups: automated daily snapshots + point-in-time recovery (≥ 7 days); a restore is
  rehearsed monthly on a scratch instance.

## 11. Security checklist for every PR

- [ ] Every new route has `@RequirePermission` or `@Public` (and `@Public` is justified)
- [ ] Data access only through `TenantDb`; no `tenantId` from the client
- [ ] Zod schema with limits for all input
- [ ] Integration test: other tenant's ID → 404; missing permission → 403
- [ ] No PII or secrets in logs, URLs or error messages
- [ ] Money changes are append-only and audited
- [ ] New table has `enable_tenant_rls()` in its migration and constraint tests pass
- [ ] No new dependency without a reason in the PR description

## 12. Incident basics

If a leak or compromise is suspected: revoke sessions and rotate affected secrets first,
preserve logs, identify affected tenants from audit and access logs, inform affected tenant
owners in writing, then write a short post-mortem in `docs/incidents/`.
