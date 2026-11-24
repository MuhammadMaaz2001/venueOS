# 09 — Phase 0 plan (foundations) and MVP module order

Goal of Phase 0: an empty but production-shaped product. A user can sign up, create a tenant,
log in, switch tenants, invite a staff member with a role, and every guard, the tenant-scoped
DB client, RLS and CI are in place. No business modules yet.

Estimated 3 weeks for a team of 3–4 developers.

## Task order

P0-0 → P0-1 → P0-2 → P0-3 → P0-5 → P0-6a → P0-4 → P0-6b → P0-7 → P0-8

Why this order: signup (P0-4) creates the owner membership with a default role (needs the
permissions and roles from P0-5) and sends the verification email (needs the email provider from
P0-6a). So authorization and the email plumbing come before auth, and the rest of the worker
(PDF skeleton, job base class polish) follows it.

## Phase 0 tasks

- [x] **P0-0 Docs + schema fixes** (done): data model, SQL, roles, tests and docs revised after
      review (snake_case columns, `timestamptz`, `Decimal(18,3)`, append-only ledgers enforced by
      grants, auth tables behind `venueos_auth`, composite tenant FKs, `quotations`,
      `refund_requests`, `invitations`, `login_attempts`, inventory `on_hand`, Prisma 7 schema).
      **P0-0b** (done): payment status by method, signed line items with per-kind CHECKs,
      `inventory.reconcile` job documented, offboarding purge moved to post-MVP, `.gitattributes`,
      and the `set_config`-in-transaction gate added to P0-2.
- [x] **P0-1 Monorepo skeleton**: pnpm workspaces, Turborepo, shared tsconfig/eslint/prettier,
      `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker` (NestJS standalone),
      `packages/{db,shared,api-client,templates}`, docker-compose (Postgres 16 + roles, Mailpit),
      `.env.example` files, `pnpm dev` runs everything. Exact (pinned) dependency versions, Node 24
      via `engines`/`packageManager`. next-intl **without** a `/[locale]` segment. The `db` package
      gets `prisma` + `@prisma/adapter-pg` + `pg` + `dotenv`, a `prisma.config.ts`
      (`MIGRATE_DATABASE_URL`; the Prisma 7 CLI, including the `migrate diff` the constraint test
      runs before migrations exist, needs it) and the scripts `db:migrate`, `db:seed`,
      `test:constraints` (`node --test "tests/*.test.mjs"`). ESLint rules: ban importing the
      generated Prisma client (`packages/db/src/generated/prisma`) outside `packages/db`, ban
      `dangerouslySetInnerHTML`, ban `$queryRawUnsafe`/`$executeRawUnsafe` except in
      `packages/db/src/pgboss-adapter.ts`.
- [x] **P0-2 Database package** (done): the **set_config gate passed first** (`tests/gate-set-config.test.ts`:
      as `venueos_app` through the Prisma 7 `pg` adapter, `set_config('app.tenant_id', t, true)` is
      visible inside one `prisma.$transaction`, RLS blocks tenant 2's rows and writes there, and the
      next transaction on the same pooled connection, after commit or rollback, sees no tenant).
      First migration `20261123073702_init` = generated DDL + `001_constraints_and_rls.sql` appended
      (reviewed by hand; the constraint test now applies `prisma/migrations/*`). `TenantDb`
      (`tx()`, `asUser()`, optional ambient `getContext`), `AuthDb` (`venueos_auth`) and
      `pgboss-adapter.ts` (the only `$queryRawUnsafe`) in `packages/db/src`; integration tests
      cover isolation, concurrency, auth-table access and the adapter. Seed (`pnpm db:seed`,
      idempotent): plans, a demo tenant (venue, 4 spaces incl. one combined, Lunch/Dinner slots,
      subscription) and its owner, credentials from `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`
      (refused when missing or `NODE_ENV=production`). **Seed creates NO roles or permissions
      except one placeholder `Owner` role (`id = seed_role_owner`, `permissions = []`,
      `is_system = true`)** because `memberships.role_id` is NOT NULL. **P0-5 must UPDATE that
      role by its fixed id (`seed_role_owner`) with the real permission set, not create a second
      Owner role**; the seed never overwrites an existing row (`update: {}`), so re-running it
      after P0-5 is safe. In `packages/shared`: currency minor-unit map (ISO 4217), money helpers
      (`money`, `roundMoney`, `formatMoney`, `parseMoney`, `sumMoney`; decimal.js, half-up, numbers
      rejected) and the `TenantSettings` Zod schema with the defaults from `05-business-rules.md` §15.
      **Package exports decision:** workspace packages are consumed as **compiled `dist`**
      (CommonJS, `exports` -> `./dist/index.js` + types; `build` = `tsc`, `dev` = `tsc --watch`).
      `api` and `worker` compile to CommonJS with `nest build`, so raw `.ts` exports would not run in
      Node, and Prisma's generated client has to be compiled anyway. Turbo's `dev`, `build`,
      `typecheck` and `test` all depend on `^build`. `@venueos/db` exports `TenantDb`, `AuthDb`,
      `pgBossDb`, enums and model types, **never** `PrismaClient`. A worker-side `ScannerDb`
      (`venueos_jobs`) is left to P0-6a.
- [x] **P0-3 API foundation** (done): config validation (Zod, refuses to boot), pino logging with
      redaction (`requestId`/`tenantId`/`userId` from CLS), request ID, domain errors + one exception
      filter + error format (`SLOT_TAKEN` mapped from `space_occupancies_no_overlap`), Zod validation
      pipe, Swagger at `/docs` (off in production unless `SWAGGER_ENABLED`), `GET /health` and
      `GET /health/ready` (outside `/v1`), helmet, in-memory throttler, `CsrfGuard`, CLS context,
      `@Public()` / `@RequirePermission()` as metadata only. Also: `pnpm dev` restarts api and worker
      when `packages/shared` or `packages/db` is rebuilt (`scripts/dev-node.mjs`), and
      `pnpm api-client:generate` exports the OpenAPI document and generates types
      (`openapi-typescript`). Handed on: bearer-token CSRF exemption hook (P0-4), the queue readiness
      check (P0-6a), the `TRUST_PROXY` staging check (P0-8, see docs/08).
- [x] **P0-5 Authorization** (done): `permissions.ts` in shared (43 names, typed `Permission`; a test
      compares it with the table in `04-security.md`), `DEFAULT_ROLES` (five system roles with permission
      sets and `maxDiscountPct`, mirrored in `01-product-scope.md` and checked by a test), the seed fills
      the placeholder Owner role `seed_role_owner` in place (only while its permissions are empty; no
      second Owner) and creates the other four. Guards in the order of `02-system-design.md`:
      `AuthGuard` (asks an `AuthContextProvider`; the default authenticates nobody, so every non-public
      route is 401 until P0-4), `TenantGuard` (membership + role + `venueIds` + limits into CLS; SUSPENDED
      = read-only with `403 TENANT_SUSPENDED`, CANCELLED = 403), `PermissionGuard`, `EntitlementGuard`
      (`@Entitlement('maxVenues'|'maxSpaces'|'maxUsers')`, 402 `PLAN_LIMIT_REACHED`). `VenueScope` helper.
      Route-scan test (every route has exactly one of `@Public()` / `@RequirePermission()`).
      `AuditService.record(tx, ...)` (USER or SYSTEM actor, masked sensitive fields, same transaction).
      Role endpoints `GET/POST /v1/roles`, `GET/PATCH /v1/roles/:id` (create by copying; system role
      names locked; privilege-escalation and Owner lock-out guards, see `04-security.md` section 2).
      API integration tests run against a throwaway migrated Postgres (`apps/api/test/global-setup.mjs`,
      needs the same Postgres as `test:constraints`). The test identity stub lives in test files only and
      a test proves the production `AppModule` never registers it. **Moved out of P0-5:** staff invitation
      create/revoke (it needs the email provider of P0-6a and auth), now part of P0-4 together with accept.
      **Not built (follow-ups):** audit log viewer (`audit.view`), role delete/retire.
- [x] **P0-6a Worker foundation (part 1)** (done): pg-boss 12.39 (pinned) with its `pgboss` schema,
      the `email.send` queue and its dead-letter queue created by the migration
      `pgboss_jobs_and_email_queue` (generated by `packages/db/scripts/pgboss-sql.mjs`; a test compares
      the library's schema version with `pgboss.version`). Grants: `venueos_app` enqueue only,
      `venueos_jobs` read/write on `pgboss.*` (the worker's connection), `venueos_auth` none.
      `JobQueue` + `enqueueEmail` in `@venueos/db` and `EmailOutbox.enqueue(tx, ...)` in the API enqueue in
      the caller's transaction (proved: a rolled-back transaction leaves no job and no `message_logs`
      row). The job payload is `{ tenantId, messageKey }` only; recipient, template, locale, variables and
      reply-to are columns of the `queued` `message_logs` row (new columns `template`, `locale`,
      `template_vars`, `reply_to`, `attempt`, `is_final`). Worker: Zod-validated config, `PgBossService`,
      `TenantJob` base class (tenant-scoped short transactions, `jobId`/`tenantId` on every log line,
      retries 5x with backoff then dead-letter; `INVALID_PAYLOAD`/`UNKNOWN_TEMPLATE` dead-letter at
      once), `EmailProvider` with SMTP (Mailpit) and SES, `email.send`. `packages/templates`:
      escaping email renderer with one sample template. `/health/ready` now includes `queue`.
      **Not built:** tenant-editable templates, PDFs, scanners and scheduled jobs (pg-boss `schedule` is
      off), the dead-letter runbook/redrive (P0-6b). **Note:** the SQL comment in
      `prisma/sql/001_constraints_and_rls.sql` (and the init migration) that says the pg-boss grants
      arrive "with the worker, task P0-6" is left as is: an applied migration is never edited.
- [x] **P0-4 Auth** (done): the real `SessionAuthContextProvider` (cookie hash lookup through `AuthDb`;
      `NoAuthContextProvider` is gone), `@AuthenticatedOnly()` (route-scan: exactly one of three markers),
      sessions (`__Host-vos_session`, 12 h idle / 30 d absolute, rotation on login and tenant switch, logout,
      logout-all, revocation on password change/reset), signup (user + tenant + 5 roles + owner + TRIAL 14 days
      on the `starter` plan + audit, one 202 answer), email verification, login (argon2id PHC, rehash, lockout
      5/15 min per address, 20/15 min per IP, one generic 401), password reset (30 min, single use), staff
      invitations (create/list/revoke/accept for new and existing users, plan limit counts pending ones, partial
      unique index), staff list/patch with the last-owner rule, escalation checks, abuse limits for the mail
      endpoints (`auth_requests`), sealed secret email variables (AES-256-GCM, AAD `tenant:messageKey`),
      templates `auth.verify-email`, `auth.account-exists`, `auth.password-reset`, `staff.invite` (en + ur),
      breached-password check (SecLists top 10k, MIT, see `modules/auth/data/NOTICE.md`). Migration
      `auth_requests_and_pending_invitations`. Checked in a real browser: `__Host-` cookie set and sent over
      `http://localhost` through a Next `/api` rewrite (signup, mail via the worker into Mailpit, verify, login,
      `/me`, switch, logout). **Not built:** bearer auth (`isBearerAuthenticated()` is still a stub), phone OTP,
      platform admin, the `auth.purge` job (P0-6b), the audit-log viewer.
- [x] **P0-6b Worker foundation (part 2)** (done): `SystemJob` base (tenant-less jobs) next to `TenantJob`, jobs may
      return a small output (codes, keys), cron schedules registered at start from a job's `schedule`
      (`SCHEDULER_ENABLED`), the migration `worker_queues_p0_6b` (queues `pdf.render`, `auth.purge`,
      `ops.dead-letter-check` and their `.dead` queues, no new grants). **Scanner infrastructure**: `ScannerDb`
      (`venueos_jobs`, ids only, anything but `id` / `tenant_id` refused, keyset pages) and `Scanner` (one strict,
      singleton-keyed job per item); no production scanner yet (tests use their own). **`auth.purge`** (daily 03:00
      Asia/Karachi, the only `AuthDb` user in the worker): sessions, tokens, invitations, `login_attempts` kept 30
      days, `auth_requests` 1 day, and for signups unverified after 30 days only credentials and tokens (proved: the
      same address can sign up again). **`pdf.render`**: Playwright Chromium (JavaScript and network off, shared
      browser, `PDF_CONCURRENCY`), bundled Noto fonts (Nastaliq, Naskh, Sans; SIL OFL) in `packages/templates`,
      `sample` document (Urdu + English), S3 storage under `tenants/{tenantId}/pdf/...` (SeaweedFS S3 gateway locally on :9100,
      image pinned by digest, IAM task role in production), fixed failure codes, the kind records the key.
      **Dead letters**: `ops.dead-letter-check` every 5 min logs `dead letters present`, the ops script
      `packages/db/scripts/dead-letters.mjs` (list, show, redrive, discard; dry run unless `--apply`) and the
      runbook in docs/08. Worker config: `AUTH_DATABASE_URL` and `S3_BUCKET` are now required.
      **Not built:** real document kinds (quotation, receipt, event sheet: with their modules), real scanners
      (`holds.expire`, reminders, ...), tenant-editable templates, Dockerfiles.
- [ ] **P0-7 Web foundation**: layout shell (sidebar, tenant switcher, user menu), auth pages,
      `/api` rewrite, api-client wiring with TanStack Query, next-intl (en/ur + RTL, no locale
      URL segment), shadcn/ui, format helpers (currency minor units, venue timezone), error
      toasts mapped from API codes.
- [ ] **P0-8 CI/CD**: GitHub Actions (lint, typecheck, tests, constraint tests with a Postgres
      service container, audit, gitleaks, Docker builds). `pnpm test` of `apps/worker` needs the same
      Postgres **and a Mailpit service container** (SMTP :1025, HTTP API :8025; `SMTP_URL` and
      `MAILPIT_API_URL` override the defaults). `pnpm test` of `apps/api` also needs that
      Postgres (the role script run and `VENUEOS_TEST_ADMIN_URL` set), like `test:constraints`, staging deploy on AWS (web and API in
      the same VPC). Includes the staging smoke check that the API logs the **real client IP**
      (not the web server's) so `TRUST_PROXY` matches the hop count (docs/08).

**Exit gate:** constraint tests + tenant isolation integration tests green in CI; a staff user
invited into tenant A cannot see anything of tenant B through any endpoint.

### Handoff from P0-5 (what P0-4 must wire up)

1. **Who fills `AuthContext`.** Provide the real `AuthContextProvider` (replace `NoAuthContextProvider`
   in `common/access/access.module.ts`): hash the `__Host-vos_session` cookie, load a live
   `auth_sessions` row through `AuthDb`, slide `last_seen_at`, and return
   `{ userId, sessionId, activeTenantId }`. No valid session: return `undefined` (the guard answers
   401) or throw `SessionExpiredError` (`401 SESSION_EXPIRED`) for an expired one. Never decide identity
   from a header or from the body.
2. **Guard order** is fixed in `app.module.ts`: throttler, `CsrfGuard`, `AuthGuard`, `TenantGuard`,
   `PermissionGuard`, `EntitlementGuard`. `AuthGuard` already exists and calls the provider; P0-4 adds no
   guard, it supplies the provider (and may move provider-specific 401 handling into it).
   `CsrfGuard` stays before `AuthGuard`.
3. **`isBearerAuthenticated()`** (`common/security/auth-kind.ts`) is still a stub that returns false.
   Implement it only together with bearer auth, accept only a validated token and never exempt a
   request that also carries the session cookie.
4. **Routes that need a login but no tenant** (tenant list, tenant switch, `GET /me`, accept
   invitation after login) cannot use `@RequirePermission` and the route-scan forbids undeclared routes.
   Add a third marker (for example `@AuthenticatedOnly()`), teach `TenantGuard` / `PermissionGuard` to skip
   tenant checks for it, and extend `findAccessViolations` in the route-scan test (exactly one of the
   three). Signup, login and invitation accept before login stay `@Public()`.
5. **`activeTenantId`** lives on `auth_sessions`; tenant switch rotates the token and sets it. A user with
   `activeTenantId = null` gets `403` from `TenantGuard` on tenant routes.
6. **Signup** creates the five default roles from `DEFAULT_ROLES` (`@venueos/shared`) with `is_system = true`
   and gives the first user the Owner role, in the tenant's `TenantDb` transaction, with an audit row.
7. **Owner invariant:** a tenant always keeps at least one **active** membership with the Owner role.
   Deactivating or removing the last owner, or moving them to another role, is rejected with
   `422 INVALID_STATE_TRANSITION`. Staff endpoints use `@RequirePermission('staff.manage')` and the same
   privilege-escalation rule as roles: only assign a role whose permissions the caller holds, and
   venue ids inside the caller's own scope.
8. **Invitations** (create/revoke/accept, `invitations` through `AuthDb`): create is
   `@Entitlement('maxUsers')` (count pending invitations too: a decision for P0-4), audited
   (`staff.invite`, `staff.invite.revoke`), the role id is loaded through `TenantDb` (404 if not the
   tenant's) and checked for escalation; accept follows the pattern below. `GET /v1/roles` needs
   `role.manage` only; revisit whether staff managers also need to list assignable roles.
9. **`/v1/roles` and the other endpoints** take their context from CLS (`tenantId`, `userId`, `access`);
   P0-4 must keep `userId` and `tenantId` set exactly as `AuthGuard` / `TenantGuard` do, because
   `TenantDb.tx(fn)` and `AuditService` read them.
10. **Tests** keep using `authHeader()` from `__tests__/helpers/test-auth.ts` (test-only provider
    override). Add session-based tests for the real provider; keep `no-test-auth.spec.ts` green.

### Transaction patterns for P0-4

**Signup** (user + tenant + owner membership in one logical operation):
1. Generate the tenant id (`cuid`) and user id in the API.
2. `AuthDb`: insert `users` and `user_credentials` (argon2id hash), create the verification
   token in `auth_tokens`.
3. `TenantDb` transaction with `app.user_id` = user id and `app.tenant_id` = the pre-generated
   tenant id (`set_config(..., true)`): insert `tenants` (the `tenant_visible` policy accepts the
   row because its id equals `app.tenant_id`), the default `roles`, the owner `membership`, the
   counters row, an audit row.
4. If step 3 fails, the user exists without a membership; a cleanup job (or retry on the same
   email) handles it. Both steps never share a transaction because they use different roles.

**Invitation accept:** `AuthDb` looks up `invitations` by `token_hash` (valid, not accepted or
revoked), creates the user + credentials if the email is new; then a `TenantDb` transaction with
that invitation's `tenant_id` and the user id inserts the membership (role and venue ids from the
invitation) and the audit row; finally `AuthDb` sets `accepted_at`.

**Login / session:** everything through `AuthDb` (`login_attempts`, `user_credentials`,
`auth_sessions`); `TenantGuard` then reads the membership and role with `TenantDb`.

### Handoff from P0-4

**To P0-7 (web):** the pages the emails link to are `/verify-email?token=`, `/reset-password?token=`,
`/accept-invite?token=` and `/login`, `/forgot-password` (built from `APP_ORIGIN`). Each token page should POST the token
to the API and strip it from the URL (`history.replaceState`); `Referrer-Policy` is already strict-origin. Login answers
`activeTenantId = null` when the user has several workspaces: show the workspace picker (`GET /v1/me/tenants`,
`POST /v1/me/switch-tenant`). `GET /v1/me` gives the permissions the UI needs. Map `details.reason = EMAIL_NOT_VERIFIED`
(403 on login) to the "confirm your email" screen with a resend button. Signup, resend and forgot always show the
same "check your inbox" message. Every state-changing call sends `X-Requested-With: venueos`.

**To P0-6b (`auth.purge`):** delete expired or revoked `auth_sessions`, used or expired `auth_tokens`, accepted,
revoked or long-expired `invitations`, and `login_attempts` / `auth_requests` older than a day (it is the only
worker code that uses `AuthDb`). Also: users who signed up, never verified and have no activity.

**Done in P0-6b (`auth.purge`):** all of the above, with these numbers: sessions 1 day after they ended (or
2 days idle), invitations 30 days after they ended, `login_attempts` 30 days (incident investigation, docs/04
section 12), `auth_requests` 1 day. Abandoned unverified signups lose only `user_credentials` and `auth_tokens`
(30 days); see the follow-ups below for the rest.

**To P0-7 (web) and the modules, from P0-6b:** a module that needs a PDF adds a `PdfKindHandler` (load its data in a
tenant transaction, name its template in `packages/templates/src/pdf`, `saveKey` writes the key column) to
`PdfModule`, adds its kind name to `PDF_KINDS` (`packages/shared`), and enqueues `pdf.render` inside the business
transaction with `JobQueue.send(tx, 'pdf.render', { tenantId, kind, entityId }, { singletonKey: 'kind:entityId' })`
(the singleton key is a required parameter). The browser gets the file through a pre-signed GET minted by the API from the stored key.
A module that needs a periodic cross-tenant sweep adds a `Scanner` (queue by migration). Both are described in
`apps/worker/CLAUDE.md`.

**To P0-8 (CI/CD):** the worker tests need an **S3 service container**: `chrislusf/seaweedfs` (the tag and digest are in
`docker-compose.yml`), command `server -s3 -s3.config=/etc/seaweedfs/s3.json -dir=/data -master.volumeSizeLimitMB=128
-volume.max=100` with `docker/seaweedfs/s3.json` mounted, container port 8333 mapped to :9100 (key `venueos` /
`venueos-local-secret`; `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` set to it, `S3_FORCE_PATH_STYLE=true`,
`S3_SSE=none`). The image is public and pulls normally and **Playwright's Chromium** (`playwright install --with-deps chromium`),
next to Postgres and Mailpit. The worker Dockerfile must install Chromium and its libraries (docs/08, "PDF
rendering"), and the worker's ECS task role needs `s3:PutObject` on `tenants/*` (no access keys in any
environment).

**To the later modules:** a password-protected action that needs an email uses `EmailOutbox`; anything secret in a
link goes in `secretVars`. Staff-facing listings of members use `GET /v1/staff`.

### Follow-ups (not built, from P0-6b)

- **Abandoned unverified signups keep their tenant and its slug.** `auth.purge` only removes their credentials and
  tokens: the `users` row (no DELETE for any runtime role), the tenant (a TRIAL one, with its roles, owner membership
  and audit rows) and the tenant's slug stay. Release or reclaim them in the tenant offboarding purge (docs/08,
  Tenant lifecycle): until then the email address is also still on the `users` row.
- Real document kinds for `pdf.render` (quotation, receipt, event sheet), with their templates and key columns.
- Real scanners (`holds.expire`, `reminders.*`, `leads.follow-up`, `inventory.*`) in their modules.
- A schedule whose job is removed from the code is not unscheduled automatically (docs/08).
- Dockerfiles, the CI S3 (SeaweedFS) and Chromium setup, and the CloudWatch metric filter and alarm for
  `dead letters present` (P0-8 and infrastructure code).

## MVP module order (after Phase 0)

1. Setup and onboarding (venues, spaces, combined spaces, slots, settings, wizard)
2. Catalogue and pricing (menus, packages, add-ons, price rules, tax, cancellation policies, custom fields)
3. Customers
4. Leads
5. Pricing engine + quotations (PDF, email, wa.me share)
6. Bookings + availability calendar (holds, confirm, change, cancel, hold-expiry job)
7. Payments and receipts (schedule, receipts, refund requests, reversals, reminders)
8. Event sheet
9. Vendors
10. Expenses and inventory
11. Email notifications (remaining templates, tenant template editor)
12. Dashboard and reports

(Staff, roles and audit — scope module 2 — is built in Phase 0 as P0-5.)

## Prompt template for Claude Code (one task at a time)

```text
Task: <task id and name, e.g. P0-2 Database package>

Read first: CLAUDE.md, docs/02-system-design.md, docs/04-security.md,
<the specific docs/sections for this task>.

Scope:
- <bullet list copied from the task above>

Acceptance criteria:
- <observable results, e.g. "pnpm --filter @venueos/db test:constraints passes">
- Integration tests for every new endpoint: happy path, 400, 403, other-tenant 404
- pnpm lint, typecheck and test pass

Constraints:
- Follow the non-negotiable rules in CLAUDE.md
- Do not build anything outside this scope; list follow-ups instead
- If a rule is unclear or conflicts, stop and ask
- Do not run git commit/push/merge/rebase/branch commands or open PRs; leave changes
  uncommitted

When done: summarize files changed, decisions made, and any follow-ups; list the changed files
and suggest a conventional commit message.
```

### First prompt (P0-1)

```text
Task: P0-1 Monorepo skeleton for venueOS.

Read CLAUDE.md, docs/02-system-design.md and docs/09-phase-0-plan.md first.

Create a pnpm + Turborepo monorepo (Node 24, TypeScript strict, pinned dependency versions) with:
- apps/web: Next.js App Router, Tailwind, shadcn/ui initialised, next-intl with en/ur (no
  /[locale] URL segment), a placeholder home page, /api/* rewrite to API_INTERNAL_URL
- apps/api: NestJS on port 4000 with GET /health and Swagger at /docs
- apps/worker: NestJS standalone app that boots and logs "worker ready"
- packages/db (prisma/ and tests/ already exist here: keep them as they are; add package.json
  with prisma 7, @prisma/adapter-pg, pg, dotenv, a prisma.config.ts reading MIGRATE_DATABASE_URL,
  and scripts db:migrate, db:seed, test:constraints),
  packages/shared, packages/api-client, packages/templates (empty, with package.json named
  @venueos/*)
- Shared configs: tsconfig base, ESLint (including rules banning the generated Prisma client
  import outside packages/db, banning dangerouslySetInnerHTML and banning $queryRawUnsafe/
  $executeRawUnsafe except in packages/db/src/pgboss-adapter.ts), Prettier
- docker-compose.yml with postgres:16 and mailpit (already in the repo, adjust if needed)
- Root scripts: dev, build, lint, typecheck, test
Acceptance: pnpm install && pnpm dev starts all three apps; pnpm lint and pnpm typecheck pass;
GET localhost:4000/health returns 200; pnpm --filter @venueos/db test:constraints passes against
the docker-compose Postgres.
Do not implement auth or business modules yet. Do not touch git.
```
