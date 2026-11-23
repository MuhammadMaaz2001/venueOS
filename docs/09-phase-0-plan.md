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
- [ ] **P0-5 Authorization**: `permissions.ts` in shared (mirrors `04-security.md`), default
      roles seed (UPDATE the placeholder Owner role `seed_role_owner` created by the P0-2 seed;
      do not create a second one), `TenantGuard` (including SUSPENDED = read-only, `403 TENANT_SUSPENDED`),
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
      the same VPC). Includes the staging smoke check that the API logs the **real client IP**
      (not the web server's) so `TRUST_PROXY` matches the hop count (docs/08).

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
