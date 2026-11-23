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
- [ ] **P0-2 Database package**: **FIRST acceptance test, before building `TenantDb`:** one test
      against the Docker Postgres, connected as `venueos_app` through the Prisma 7 `pg` adapter,
      proves that (a) inside a single `prisma.$transaction(async tx => ...)`,
      `set_config('app.tenant_id', <t1>, true)` is visible to the following statements
      (`current_setting` returns t1 and tenant-1 rows are selectable), (b) RLS blocks tenant 2's
      rows and rejects a write for tenant 2 in that same transaction, and (c) after commit the
      next transaction on the pooled connection sees no tenant (no leakage). **If it fails, P0-2
      stops and reports back before `TenantDb` is built.** Then: first migration = generated DDL with
      `001_constraints_and_rls.sql` appended (review it by hand; from then on the constraint test
      applies `prisma/migrations/*` instead of generating the DDL),
      `TenantDb` (`tx()`, `asUser()`), `AuthDb` (`venueos_auth` connection), `pgboss-adapter.ts`,
      seed (plans, demo tenant, default roles; sets `app.tenant_id`/`app.user_id` as needed),
      `test:constraints` green. In `packages/shared`: currency minor-unit map (ISO 4217), money
      helpers, `TenantSettings` Zod schema with the defaults from `05-business-rules.md` §15.
- [ ] **P0-3 API foundation**: config validation (Zod), pino logging with redaction,
      request ID, exception filter + error format, Zod validation pipe, Swagger at `/docs`,
      health endpoints, helmet, throttler, CLS context.
- [ ] **P0-5 Authorization**: `permissions.ts` in shared (mirrors `04-security.md`), default
      roles seed, `TenantGuard` (including SUSPENDED = read-only, `403 TENANT_SUSPENDED`),
      `PermissionGuard`, `@RequirePermission` / `@Public`, route-scan test, entitlements guard,
      role CRUD, staff invitation create/revoke (rows in `invitations` through `AuthDb`), audit
      service (`actor_type` + `actor_user_id`).
- [ ] **P0-6a Worker foundation (part 1)**: pg-boss setup (its `pgboss` schema created by the
      migrator; grant `venueos_app` and `venueos_jobs` usage on it), job base class (tenant
      context, idempotency, retries), `EmailProvider` + `email.send` job with Mailpit/SES provider,
      `message_logs` written as append-only events.
- [ ] **P0-4 Auth**: signup, email verification, login/logout, sessions (hashed tokens,
      `__Host-` cookie), lockout via `login_attempts`, password reset, "log out everywhere",
      tenant list + switch, invitation accept. Transaction patterns (see below).
- [ ] **P0-6b Worker foundation (part 2)**: `pdf.render` skeleton with Playwright and bundled
      Urdu font, `auth.purge` job, dead-letter handling and runbook.
- [ ] **P0-7 Web foundation**: layout shell (sidebar, tenant switcher, user menu), auth pages,
      `/api` rewrite, api-client wiring with TanStack Query, next-intl (en/ur + RTL, no locale
      URL segment), shadcn/ui, format helpers (currency minor units, venue timezone), error
      toasts mapped from API codes.
- [ ] **P0-8 CI/CD**: GitHub Actions (lint, typecheck, tests, constraint tests with a Postgres
      service container, audit, gitleaks, Docker builds), staging deploy on AWS (web and API in
      the same VPC).

**Exit gate:** constraint tests + tenant isolation integration tests green in CI; a staff user
invited into tenant A cannot see anything of tenant B through any endpoint.

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
