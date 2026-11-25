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
  purged by the daily `auth.purge` job: `login_attempts` after **30 days** (the limits only look back 15
  minutes; the rest is for incident investigation, section 12), `auth_requests` after 1 day, ended sessions after
  1 day, used or expired tokens, old invitations after 30 days. A signup that never verified its email loses
  its password hash and tokens after 30 days; the user row, the tenant it created and the audit rows stay (no
  runtime role may delete them: they go with the tenant offboarding purge, section 6).
- **One-time tokens** (email verify, password reset): 32 random bytes, stored hashed in
  `auth_tokens`, single use, expiry 30 min (reset). Reset request always answers
  "if the account exists, we sent an email".
- **Staff invitations** are rows in `invitations` (tenant, email, role, venue ids, `token_hash`,
  `expires_at` 72 h, `accepted_at`, `revoked_at`), not auth tokens. Accepting looks the row up by
  token, creates the user + credentials if needed (through `AuthDb`), then inserts the membership
  in that tenant's context.
- Mobile/public API (later): short-lived access tokens + rotating refresh tokens on
  `api.venueos.app`; never cookies there.

### Implementation notes (P0-4)

- **Enumeration safety.** Signup, resend-verification and password/forgot always answer the same 202 body, whether
  or not the address has an account; login answers one generic 401 (unknown address, wrong password and locked
  account alike) and always runs a real argon2 verification (a dummy hash for unknown or locked accounts), so the
  response time does not tell either. The only distinguishable answer comes after the CORRECT password: an
  unverified address gets 403 `FORBIDDEN` with `details.reason = EMAIL_NOT_VERIFIED` (the constant `EMAIL_NOT_VERIFIED_REASON` of `@venueos/shared`, used by the API and the web login).
- **Abuse limits of the mail endpoints** (signup, resend-verification, password/forgot): at most 3 emails per
  address per hour and 20 requests per IP per 15 minutes, counted in `auth_requests` (email hash and IP, never the
  address). Over the limit: the same generic answer, nothing sent, a log line. Refused requests count toward the
  IP limit only, so hammering an address cannot extend the lock on it. Accepted trade-off: someone who sends 3
  requests for an address can delay a real reset mail for that address for up to an hour.
- **Signup of an address that exists.** Verified: an "account exists" mail, nothing else. Unverified: the latest
  signup wins (name and password are replaced, earlier tokens die, a fresh verification mail goes out, still one
  workspace), so someone who pre-registered another person's address cannot keep the account: only the mailbox
  owner can verify, and verifying binds the account to whoever signed up last.
- **Account mail** (verification, "account exists", password reset) is sent under the product name "venueOS"
  (template metadata), never a tenant's name. The log row belongs to the user's oldest membership's tenant (RLS);
  a user without any workspace gets nothing and the same generic answer. Verification tokens last 24 h, reset
  tokens 30 min, invitations 72 h; starting a new one invalidates the unused earlier ones of that purpose.
- **Sessions** are revoked by timestamp, never deleted. Login always creates a new token and revokes the session
  it was called with; tenant switch replaces the token of the same row. `__Host-vos_session` is `Secure`, which
  Chrome and Firefox also accept on `http://localhost` in development.
- **Invitations** are `invitations` rows (hash of the token only). At most one pending invitation per tenant
  and address (partial unique index); an expired one is revoked when a new one is issued. Pending invitations
  count toward the plan's `maxUsers` (checked under an advisory lock). A new person accepts with name and
  password (the token proves the mailbox); an address that already has an account gets 409 and accepts while
  logged in (`POST /v1/me/invitations/accept`, the session's verified email must match).
- **Staff changes** never grant more than the caller holds and never touch a member whose role or venue scope is
  wider than the caller's. A tenant always keeps one active Owner: the check locks the tenant row, then counts the
  other active members of the system "Owner" role.

## 2. Authorization

- Permissions are strings like `booking.confirm`, defined once in
  `packages/shared/src/permissions.ts`, which mirrors the table below (**this doc is the source
  of truth**). Roles are sets of permissions plus limits (`maxDiscountPct`). Default roles are
  seeded per tenant (`is_system`); tenants may copy and edit them.
- Every controller method has exactly one of `@RequirePermission(...)`, `@AuthenticatedOnly()` (a login but no
  tenant: `/me`, tenant switch, logout) or `@Public()`. A test scans all routes
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
- **A role that may manage an area may also see it.** A role holding `<area>.manage` must hold `<area>.view` where a view
  permission exists (`venue`, `catalogue`, `pricing`, `customer`, `lead`, `vendor`): otherwise the role edit is
  `400 VALIDATION_ERROR` naming the missing permission (`requiredViewPermission` in `packages/shared`). Areas without a
  view permission (`staff`, `role`, `billing`, `template`, `tenant.settings`) have no pair. `DEFAULT_ROLES` satisfy it
  (a test proves it).
- **Retiring roles.** `PATCH /v1/roles/{id}` with `active: false` retires a custom role; `true` restores it. A system
  role cannot be retired and a role with active members cannot be retired (`422 INVALID_STATE_TRANSITION`; the check runs
  under a row lock that assignments share, so a member added a moment ago counts). A retired role is frozen (no edit, no
  copy), is not offered by `GET /v1/staff/assignable-roles`, and cannot be given by `PATCH /v1/staff/{id}` or an
  invitation (`422`); an invitation accepted after its role was retired is `422` and stays usable once the role is
  restored. Both changes are audited (`role.retire`, `role.restore`).
- **Audit log access.** `audit.view` reads `GET /v1/audit-logs` (and `/{id}`). Venue scoping applies: a caller whose
  membership lists venues sees only rows whose `audit_logs.venue_id` is one of them; rows without a venue (settings,
  roles, staff, event types, invitations) are visible only with access to all venues. An out-of-scope id is `404`.
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
| Setup | `venue.view`, `venue.manage`, `catalogue.view`, `catalogue.manage`, `pricing.view`, `pricing.manage` |
| CRM | `customer.view`, `customer.manage`, `customer.view_sensitive`, `lead.view`, `lead.manage` |
| Bookings | `quotation.manage`, `quotation.send`, `booking.view`, `booking.view_prices`, `booking.create`, `booking.edit`, `booking.hold`, `booking.extend_hold`, `booking.confirm`, `booking.confirm_override`, `booking.cancel`, `booking.edit_locked`, `booking.override_rules` |
| Money | `payment.view`, `payment.record`, `payment.reverse`, `payment.refund.request`, `payment.refund.approve` |
| Operations | `eventsheet.view`, `vendor.view`, `vendor.manage`, `expense.view`, `expense.record`, `expense.reverse`, `inventory.view`, `inventory.record`, `inventory.adjust` |
| Reports | `report.view`, `report.financial` |

`venue.view` reads venues, spaces, slot templates and event types (every default role has it, so pickers and
calendars work for everyone); `venue.manage` writes them and also reads the per-slot rent lists. A space's default
`baseRent` is shown only to callers with `venue.manage` or `booking.view_prices` (others get `null`). Grant
`venue.view` together with `venue.manage`: the API does not infer one from the other.

**Catalogue and pricing (module 3).** `catalogue.view` reads menu items, packages, add-ons and custom field definitions,
`catalogue.manage` writes them; `pricing.view` reads price rules, tax rates, cancellation policies and the rent preview,
`pricing.manage` writes them (each manage needs its view, see above). Both are tenant-wide data, so **a write needs access
to all venues** (`403 FORBIDDEN` for a caller limited to some venues, like event types); the one exception is a price
rule scoped to a space or slot of the caller's own venues, which a venue-limited `pricing.manage` holder may create and
edit (a rule that applies everywhere, or one of another venue, stays out of reach: 403 / 404). Catalogue prices
(`packages.perHeadRate`, `add_ons.price`) are `null` for a reader who has neither `catalogue.manage` nor
`booking.view_prices` (Operations sees the dishes, not the rates), the same rule as `spaces.baseRent`. Every foreign id a
client sends (menu item, space, slot) is loaded through `TenantDb` first (404). All changes are audited
(`menu_item.*`, `package.*`, `add_on.*`, `price_rule.*`, `tax_rate.*`, `cancellation_policy.*`, `custom_field.*`;
price rules scoped to a space or slot carry that venue's id for venue-scoped reading of the audit log).

**Customers and leads (modules 4 and 5).** `customer.view` reads customers (tenant-wide data), `customer.manage` writes them; a role that manages needs the view. `customer.view_sensitive` is a separate permission: without it a sensitive custom field (a CNIC) is only ever returned masked, and `POST /v1/customers/{id}/reveal/{fieldKey}` is `403`. Holding `customer.manage` lets a person ENTER or replace a sensitive value, not read it back. `lead.view` / `lead.manage` read and write leads, which belong to a venue: **venue scoping applies** (a lead of another venue is `404` on read, edit, activity, and as a target of create / move). An assignee must be an active member of the workspace whose role holds `lead.manage` and whose venues cover the lead's venue (another workspace's member is `404`, an ineligible one `400` on `assigneeId`). Creating a customer inline with a lead also needs `customer.manage`. Audited: `customer.create`, `.update`, `.deactivate`, `.reactivate`, `.reveal_sensitive`, and `lead.create`, `.update`, `.stage_change`, `.assign` (leads carry their venue id for venue-scoped reading of the audit log).

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
- **PDF rendering is sandboxed.** Chromium renders a self-contained HTML string with JavaScript off, service
  workers blocked and every network request aborted (a template cannot reach a metadata endpoint, an internal
  service or a file), the document's CSP is `default-src 'none'`, output is capped at 10 MB and 30 s, and the object
  key is derived from the job payload and checked to be `tenants/{tenantId}/...` before the upload. The worker
  reaches S3 through its IAM task role, never through access keys (docs/08).
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
    (there is still no bearer auth: P0-4 did not add it; it belongs to the API-token work). It must accept only a *validated* token, never just the header,
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
- **Sensitive custom fields (module 4).** Only customer fields can be marked sensitive (text, number, phone). The value is sealed with the field keyring when it is written (AAD = tenant, customer id and field key, so a blob copied to another customer or field does not open) and stored with its masked hint (`*****-*****67-1`: separators stay, only the last characters show, never more than a third of the value); lists and detail reads return the hint and never decrypt. `reveal` opens one value, needs `customer.view_sensitive` and writes an audit row naming the customer and the field, never the value. The audit rows of a customer write list sensitive keys as `[REDACTED]` or by key only (`sensitiveFieldsChanged`), and nothing logs the clear value.
- Never put PII in URLs, logs, analytics events, error messages or Sentry. The pino redaction
  list covers `password`, `token`, `cookie`, `authorization`, `cnic`, `phone`, `email`, `body`.
  `login_attempts` stores a hash of the email, not the email.
- **Sealed secrets.** A value that must travel through the database but must not be readable there (the
  link of a verification, reset or invitation email, which carries a token) is sealed with AES-256-GCM using the
  `FIELD_ENCRYPTION_KEYS` keyring and stored as `v1.<keyId>.<iv>.<ciphertext>.<tag>`. The key id travels with
  the value, so keys rotate by adding a key and making it `active`; old keys keep opening old values until they
  are retired. **The AAD is `${tenantId}:${messageKey}`**, so a sealed blob copied onto another row, or into
  another tenant, fails to open; the email worker then dead-letters the message as `INVALID_PAYLOAD`. The API
  seals (`EmailOutbox` with `secretVars`), the worker opens just before rendering; neither stores or logs the
  plain value. Both refuse to boot when a key is not exactly 32 bytes.
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

**Reading the audit trail (module 2).** `GET /v1/audit-logs` (`audit.view`) lists rows newest first with cursor
pagination (`limit` default 25, max 100; the cursor is opaque and stable even for rows written in the same
millisecond) and the filters `entityType`, `entityId`, `actorUserId`, `action`, `from`, `to` (`YYYY-MM-DD` = whole days of
the workspace time zone, or ISO instants). The list carries who, what and when; `GET /v1/audit-logs/{id}` adds the
`before`/`after` and the IP. Rows are returned **exactly as stored**: secrets were replaced by `[REDACTED]` and phone
numbers / emails reduced to a hint when the row was written, so no token, hash, password or CNIC is ever in the answer
(nothing here can unmask them). Rows of venue-level entities (venue, space, slot template) carry `venue_id`, which the
venue scope filters on; the column is written by `AuditService.record` (`venueId`) and was back-filled by the migration.
Audit rows are still never updated or deleted by the app role.

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
preserve logs (`login_attempts` keeps 30 days of hashed-email and IP history for exactly this; copy what you
need out before it ages away), identify affected tenants from audit and access logs, inform affected tenant
owners in writing, then write a short post-mortem in `docs/incidents/`.
