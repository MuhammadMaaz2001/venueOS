# 04 — Security

These rules are mandatory. A change that breaks one of them is not mergeable, however urgent.

## What we protect and from whom

| Asset | Main threats |
| --- | --- |
| Tenant data (customers, bookings, revenue) | Another tenant reading it (IDOR, missing filter), a staff member exceeding their role |
| Money records | Silent edits or deletes, double-posting, inflated discounts |
| Customer PII (names, phones, CNIC, addresses) | Leaks through logs, exports, URLs, backups |
| Accounts | Credential stuffing, session theft, password reset abuse |
| Platform | Leaked secrets, vulnerable dependencies, a compromised app role |

## 1. Authentication

- Login with email + password in MVP (phone OTP later). Passwords hashed with **argon2id**
  (memory ≥ 19 MiB, iterations ≥ 2) and stored in `user_credentials` (not in `users`). Minimum
  10 characters; reject the top 10k breached passwords list. No other complexity rules.
  **Stored format: the standard PHC string** `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`
  (unpadded base64), written with Node's built-in `crypto.argon2Sync`/`crypto.argon2` (added in
  Node 24.7.0, Stable; hence `engines.node >= 24.7.0`). The P0-2 demo seed already writes this
  format (m=65536, t=3, p=4), and **P0-4 must hash and verify with exactly the same format** (parse the
  PHC string, recompute with the stored parameters, compare with `timingSafeEqual`, and rehash on
  login when the stored parameters are weaker than the current ones).
- **Sessions are server-side.** The cookie `__Host-vos_session` holds a 32-byte random token;
  the database stores only its SHA-256 hash (`auth_sessions.token_hash`).
  Cookie flags: `HttpOnly; Secure; SameSite=Lax; Path=/` (no `Domain`, host-only).
- Session lifetime: 12 h idle timeout, 30 days absolute. Rotate the token on login and on
  tenant switch. Logout revokes the row. "Log out everywhere" revokes all of a user's rows.
  Password change or reset revokes all other sessions.
- **Brute force** (all counted in the database so limits hold across instances and for unknown
  emails): every attempt writes a `login_attempts` row (`email_hash`, `ip`, `succeeded`). 5 failed
  logins per email-hash per 15 min → 15 min lock (`user_credentials.locked_until`); 20 attempts
  per IP per 15 min → 429. Same generic message for wrong email or wrong password. Old rows are
  purged by a job.
- **One-time tokens** (email verify, password reset): 32 random bytes, stored hashed in
  `auth_tokens`, single use, expiry 30 min (reset). Reset request always answers
  "if the account exists, we sent an email".
- **Staff invitations** are rows in `invitations` (tenant, email, role, venue ids, `token_hash`,
  `expires_at` 72 h, `accepted_at`, `revoked_at`), not auth tokens. Accepting looks the row up by
  token, creates the user + credentials if needed (through `AuthDb`), then inserts the membership
  in that tenant's context.
- Mobile/public API (later): short-lived access tokens + rotating refresh tokens on
  `api.venueos.app`; never cookies there.

## 2. Authorization

- Permissions are strings like `booking.confirm`, defined once in
  `packages/shared/src/permissions.ts`, which mirrors the table below (**this doc is the source
  of truth**). Roles are sets of permissions plus limits (`maxDiscountPct`). Default roles are
  seeded per tenant (`is_system`); tenants may copy and edit them.
- Every controller method has `@RequirePermission(...)` or `@Public()`. A test scans all routes
  and fails if any has neither.
- Venue scoping: a membership with `venueIds` set may only touch data of those venues. Services
  filter by `venueIds` from CLS; list endpoints never trust a `venueId` query param alone.
- **Roles cannot be used to escalate privileges.** Holding `role.manage` does not let a user grant
  what they lack: when creating (copying) or editing a role, every permission that is *added* must be held
  by the caller, and `maxDiscountPct` may not be raised above the caller's own limit (else
  `403 FORBIDDEN`). Permissions already on a role may stay or be removed by anyone with `role.manage`.
  This applies to editing the caller's own role as well.
- **Owner lock-out.** The system Owner role always keeps `role.manage` and `staff.manage` (an edit that
  removes either is rejected with `422 INVALID_STATE_TRANSITION`), and the name of a system role cannot
  be changed. A tenant must also always keep at least one active membership with the Owner role: removing
  or deactivating the last owner is rejected with `422` (enforced by the staff endpoints, P0-4).
- Guards read the caller's membership and role **on every request**, so a role edit or a deactivation
  applies on the next request. Nothing about permissions is cached.
- Value limits are checked on the server: discount above the role limit → 403
  `DISCOUNT_LIMIT`; confirming without the required advance → 422 unless the user has
  `booking.confirm_override` (audited with a reason).
- Tenant status: `SUSPENDED` tenants are read-only (`GET` allowed, writes → `403 TENANT_SUSPENDED`).
- **Refunds** are requested with `payment.refund.request` and approved with
  `payment.refund.approve`. The approver must not be the requester, **except** when exactly one
  active member of the tenant holds refund permissions (a one-person venue): that user may
  self-approve, the request is marked `self_approved`, and the audit row says so.

**MVP permission list** (keep in sync with `packages/shared/src/permissions.ts`):

| Area | Permissions |
| --- | --- |
| Tenant | `tenant.settings.manage`, `billing.manage`, `staff.manage`, `role.manage`, `audit.view`, `template.manage` |
| Setup | `venue.manage`, `catalogue.manage`, `pricing.manage` |
| CRM | `customer.view`, `customer.manage`, `customer.view_sensitive`, `lead.view`, `lead.manage` |
| Bookings | `quotation.manage`, `quotation.send`, `booking.view`, `booking.view_prices`, `booking.create`, `booking.edit`, `booking.hold`, `booking.extend_hold`, `booking.confirm`, `booking.confirm_override`, `booking.cancel`, `booking.edit_locked`, `booking.override_rules` |
| Money | `payment.view`, `payment.record`, `payment.reverse`, `payment.refund.request`, `payment.refund.approve` |
| Operations | `eventsheet.view`, `vendor.view`, `vendor.manage`, `expense.view`, `expense.record`, `expense.reverse`, `inventory.view`, `inventory.record`, `inventory.adjust` |
| Reports | `report.view`, `report.financial` |

`booking.create` / `booking.edit` cover creating and changing bookings and sessions;
`booking.edit_locked` is the extra permission inside the guest-lock window;
`quotation.manage` drafts and prices quotations, `quotation.send` emails/shares them.

## 3. Tenant isolation (three layers)

1. **Guard layer:** `TenantGuard` sets `tenantId` from the session's active tenant after
   checking the membership. Request bodies and query strings never carry `tenantId`.
2. **Client layer:** feature code only uses `TenantDb.tx()`, which sets `app.tenant_id` and
   `app.user_id` with `set_config(..., true)` (transaction-local, safe with connection pools).
   Lint rule: importing the generated Prisma client outside `packages/db` fails the build.
   `AuthModule` alone uses `AuthDb` (role `venueos_auth`) for the auth tables.
3. **Database layer:** forced RLS on every `tenant_id` table, plus `tenants` and `users`. The app
   connects as `venueos_app` (no `BYPASSRLS`, not the table owner). A forgotten filter returns
   nothing instead of another tenant's data. Same-tenant references are enforced by composite
   `(tenant_id, id)` foreign keys for the critical parent/child pairs (`03-data-model.md`).

Database roles and what each can touch are listed in `02-system-design.md` and
`03-data-model.md`. In short: `venueos_app` cannot read credentials, sessions, tokens,
invitations or login attempts, cannot delete bookings, and cannot update or delete ledgers;
`venueos_jobs` is SELECT-only on seven scanner tables plus read/write on the `pgboss` schema (the
worker's queue connection); `venueos_app` can only enqueue into `pgboss`; the migrator is not a superuser;
`resolve_tenant()` is owned by a `NOLOGIN BYPASSRLS` role that owns nothing else.

Cross-tenant work (job scanners) uses `venueos_jobs` only to find IDs, then processes each
item inside that tenant's context. Resource IDs from another tenant return **404**, never 403
(do not confirm existence).

## 4. Input, output and injection

- Zod validation on every param, query and body; unknown keys stripped. Max lengths on all
  strings, max array sizes, numeric ranges (guests 1–100000, percentages 0–100).
- Prisma parameterizes queries. Raw SQL only via tagged templates (`Prisma.sql`), never string
  concatenation. `$queryRawUnsafe` / `$executeRawUnsafe` are banned **except** in
  `packages/db/src/pgboss-adapter.ts`, where pg-boss hands us SQL text it built itself and we
  must run it parameterized (`text` + `values`) on the current transaction so that job enqueue
  is atomic with the business change. The exception is lint-allowed for that single file only;
  nothing user-controlled may reach it.
- React escapes output by default; `dangerouslySetInnerHTML` is banned (lint rule).
- **Nothing customer-related ever goes into `pgboss.job`.** The queue's tables have no Row Level
  Security and are readable by the worker's role and (for enqueue) the app role, so a job payload carries
  identifiers only: `email.send` is `{ tenantId, messageKey }` (a `.strict()` Zod schema in
  `packages/shared` rejects any extra key, and `JobQueue.send` validates before inserting). The
  recipient, template name, locale, variables (customer names, amounts, booking details) and reply-to
  live on the RLS-protected `queued` row of `message_logs`, which the worker reads inside the tenant's
  transaction. Job outputs and logs hold fixed failure codes only, never provider or driver text.
- Email/PDF templates escape every variable (`{{ }}` escapes; triple-stash is banned). Tenant
  template bodies are text with placeholders, not raw HTML.
- CSV/Excel exports: prefix cells starting with `= + - @` with `'` to stop formula injection.
- Every client-supplied ID not covered by a composite FK is loaded through `TenantDb` and
  must exist (else 404) before being written (CLAUDE.md rule 13).

## 5. Web security

- CSRF: same-origin `/api` rewrite + `SameSite=Lax` cookie, and every state-changing request
  (every method except GET/HEAD/OPTIONS) must send `X-Requested-With: venueos` and an `Origin`
  equal to `APP_ORIGIN`; the API rejects it otherwise with `403 CSRF_REJECTED` (the response does
  not say which check failed; the reason is logged). A missing `Origin` is rejected too, because
  browsers always send it on these requests. The guard (`CsrfGuard`) runs before the auth guards.
  - **Scope:** the guard protects requests a browser authenticates by itself, i.e. cookies.
    Requests authenticated by an `Authorization: Bearer` token (the future mobile app and public API
    on `api.venueos.app`) are **exempt**, because a browser never attaches that header on its own.
    Unauthenticated requests (login, signup) are not exempt: login CSRF is a real attack.
  - **Not enabled yet:** the exemption lives in one function, `isBearerAuthenticated()`
    (`apps/api/src/common/security/auth-kind.ts`), which returns `false` until bearer auth exists
    (TODO P0-4 / the API-token work). It must accept only a *validated* token, never just the header,
    and must never exempt a request that also carries the session cookie.
  - `APP_ORIGIN` is a single origin. Public booking pages on tenant (sub)domains will POST from
    other origins; they are handled with the public endpoints (`@Public()` + `resolve_tenant`), not
    by widening this allowlist.
- Security headers (helmet on API, Next.js headers on web): HSTS (1 year, includeSubDomains),
  CSP with nonces (no `unsafe-inline` scripts), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`,
  `Permissions-Policy` with camera/mic/geolocation off.
- CORS: disabled for the web app (same origin). `api.venueos.app` (future) uses an explicit allowlist.
- The API has no public listener in the MVP (web and API share a VPC; only the web app is
  internet-facing). Swagger `/docs` is disabled in production.
- Rate limits: `@nestjs/throttler` in memory per API instance for general traffic (300 req/min
  per user). Login, password reset and invite limits are enforced in the database
  (`login_attempts`, `user_credentials.locked_until`, token/invitation row counts) so they hold
  across instances. No Redis in the MVP.

## 6. Personal and sensitive data

- Collect the minimum. CNIC and similar values are only stored when the tenant defines a
  custom field marked `sensitive`; such values are encrypted by the API with AES-256-GCM and
  shown masked (`*****-*****67-1`) unless the user has `customer.view_sensitive` (audited).
  The key comes from the secret store as a **keyring** (`FIELD_ENCRYPTION_KEYS`: JSON with
  `active` key id + `keys` map); each ciphertext stores its key id so keys can be rotated.
- Never put PII in URLs, logs, analytics events, error messages or Sentry. The pino redaction
  list covers `password`, `token`, `cookie`, `authorization`, `cnic`, `phone`, `email`, `body`.
  `login_attempts` stores a hash of the email, not the email.
- Files: private S3 bucket, server-side encryption, keys `tenants/{tenantId}/...` (the
  database stores the key only), uploads via pre-signed PUT with content-type and size limits
  (images/PDF ≤ 10 MB), downloads via pre-signed GET valid 5 minutes. The API checks the
  tenant before signing.
- Tenant offboarding: export on request (CSV + PDFs). Deletion 90 days after cancellation is a
  **post-MVP** purge function run as `venueos_migrator` in dependency order (the app role cannot
  delete these rows); not implemented yet, so cancelled tenants' data is kept until then.
  Backups age out per the retention policy.

## 7. Money integrity

- Prices are computed on the server; the client never sends amounts for line items.
- Payments, expenses and inventory movements are **append-only, enforced by the database**
  (`venueos_app` has no UPDATE/DELETE on them; payments allow updating only `status` and
  `cleared_at` for cheque clearing). Corrections are `REVERSAL` entries linked to the original
  (`reverses_id`, one per original, reason required). `amount` is always positive; `entry_type`
  (`RECEIPT`, `REFUND`, `REVERSAL`) decides the effect.
- Refunds go through `refund_requests` (requested → approved/rejected → paid); approval creates
  the `REFUND` payment.
- Payment, refund request, expense and inventory movement creation requires an
  `Idempotency-Key` header; the unique `(tenant_id, idempotency_key)` makes retries safe.
- Booking, quotation and receipt numbers come from `tenant_counters` inside the same
  transaction (no gaps from rollbacks visible to users, no duplicates).
- `paidTotal` and `grandTotal` are recalculated in the transaction that changes payments or
  line items, never patched directly.
- Stock changes lock the item row (`SELECT ... FOR UPDATE`) and update `on_hand` in the same
  transaction as the movement; `CHECK (on_hand >= 0)` is the backstop.

## 8. Audit

`audit_logs` records `actor_type` (`USER`, `SYSTEM`, reserved `PLATFORM_ADMIN`) + `actor_user_id`,
action, entity, before/after (sensitive fields masked), IP and time for: booking status
changes, price/discount changes, payments, refunds (including self-approval), reversals,
expenses, inventory adjustments, role/permission changes, user invites/removals, settings
changes, sensitive-field views. Audit rows are written in the same transaction as the change
and cannot be updated or deleted by the app role.

## 9. Platform admin and support access (post-MVP)

Not part of the MVP. When built (separate app, separate login, mandatory TOTP 2FA, IP
allowlist, read-only reasoned impersonation expiring after 60 minutes, banner, audit row
visible to the tenant owner) it needs its own tables and decisions; nothing is implemented now.
Until then the platform operator uses seed/ops scripts run as `venueos_migrator`, and no code
path lets one tenant's user act inside another tenant.

## 10. Secrets, infrastructure and dependencies

- Secrets live in AWS Secrets Manager / SSM Parameter Store, injected as environment variables.
  `.env` files are git-ignored; only `.env.example` with fake values is committed.
  There is no `SESSION_SECRET`: sessions are random tokens hashed in the database.
- Separate AWS accounts or at least separate credentials and databases for staging and
  production. Production data is never copied to staging or developer machines.
- Database not publicly reachable; TLS required; five distinct roles (migrator, definer, app,
  auth, jobs) with the privileges in `03-data-model.md`; the app roles have DML only.
- CI runs `pnpm audit --prod`, secret scanning (gitleaks) and dependency updates
  (Renovate/Dependabot). Lockfile is committed; no `latest` versions.
- Backups: automated daily snapshots + point-in-time recovery (≥ 7 days); a restore is
  rehearsed monthly on a scratch instance.

## 11. Security checklist for every PR

- [ ] Every new route has `@RequirePermission` or `@Public` (and `@Public` is justified)
- [ ] Data access only through `TenantDb` (or `AuthDb` inside `AuthModule`); no `tenantId` from the client
- [ ] Zod schema with limits for all input; every foreign ID that is not a composite FK is loaded first
- [ ] Integration test: other tenant's ID → 404; missing permission → 403
- [ ] No PII or secrets in logs, URLs or error messages
- [ ] Money changes are append-only (reversals), idempotent and audited
- [ ] New table: RLS helper, `rev` trigger, privilege class and constraint tests in its migration
- [ ] No new dependency without a reason in the PR description

## 12. Incident basics

If a leak or compromise is suspected: revoke sessions and rotate affected secrets first,
preserve logs, identify affected tenants from audit and access logs, inform affected tenant
owners in writing, then write a short post-mortem in `docs/incidents/`.
