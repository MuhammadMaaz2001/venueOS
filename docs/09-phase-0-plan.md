# 09 — Phase 0 plan (foundations) and MVP module order

Goal of Phase 0: an empty but production-shaped product. A user can sign up, create a tenant,
log in, switch tenants, invite a staff member with a role, and every guard, the tenant-scoped
DB client, RLS and CI are in place. No business modules yet.

Estimated 3 weeks for a team of 3–4 developers.

## Phase 0 tasks

- [ ] **P0-1 Monorepo skeleton**: pnpm workspaces, Turborepo, shared tsconfig/eslint/prettier,
      `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker` (NestJS standalone),
      `packages/{db,shared,api-client,templates}`, docker-compose (Postgres 16, Mailpit),
      `.env.example` files, `pnpm dev` runs everything.
- [ ] **P0-2 Database package**: Prisma schema from `packages/db/prisma/schema.prisma`, first
      migration with `001_constraints_and_rls.sql` appended, DB roles
      (`venueos_migrator`, `venueos_app`, `venueos_jobs`), `TenantDb` with `tx()` and
      `asUser()`, seed (plans, demo tenant, default roles), `test:constraints` script.
- [ ] **P0-3 API foundation**: config validation (Zod), pino logging with redaction,
      request ID, exception filter + error format, Zod validation pipe, Swagger at `/docs`,
      health endpoints, helmet, throttler, CLS context.
- [ ] **P0-4 Auth**: signup (creates user + tenant + owner membership in one transaction),
      email verification, login/logout, sessions (hashed tokens, `__Host-` cookie), lockout,
      password reset, "log out everywhere", tenant list + switch.
- [ ] **P0-5 Authorization**: `permissions.ts` in shared, default roles seed, `TenantGuard`,
      `PermissionGuard`, `@RequirePermission` / `@Public`, route-scan test, entitlements guard,
      staff invite + accept, role CRUD, audit service.
- [ ] **P0-6 Worker foundation**: pg-boss setup (its `pgboss` schema created by the migrator; grant `venueos_app` and `venueos_jobs` usage on it), job base class (tenant context, idempotency,
      retries), `email.send` job with Mailpit/SES provider, `pdf.render` skeleton with
      Playwright and bundled Urdu font.
- [ ] **P0-7 Web foundation**: layout shell (sidebar, tenant switcher, user menu), auth pages,
      `/api` rewrite, api-client wiring with TanStack Query, next-intl (en/ur + RTL), shadcn/ui,
      format helpers, error toasts mapped from API codes.
- [ ] **P0-8 CI/CD**: GitHub Actions (lint, typecheck, tests, constraint tests, audit,
      gitleaks, Docker builds), staging deploy.

**Exit gate:** constraint tests + tenant isolation integration tests green in CI; a staff user
invited into tenant A cannot see anything of tenant B through any endpoint.

## MVP module order (after Phase 0)

1. Setup and onboarding (venues, spaces, combined spaces, slots, settings, wizard)
2. Catalogue and pricing (menus, packages, add-ons, price rules, tax, cancellation policies, custom fields)
3. Customers
4. Leads
5. Pricing engine + quotations (PDF, email, wa.me share)
6. Bookings + availability calendar (holds, confirm, change, cancel, hold-expiry job)
7. Payments and receipts (schedule, receipts, refunds, reversals, reminders)
8. Event sheet
9. Vendors
10. Expenses and inventory
11. Email notifications (remaining templates, tenant template editor)
12. Dashboard and reports

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

When done: summarize files changed, decisions made, and any follow-ups.
```

### First prompt (P0-1)

```text
Task: P0-1 Monorepo skeleton for venueOS.

Read CLAUDE.md and docs/02-system-design.md first.

Create a pnpm + Turborepo monorepo (Node 24, TypeScript strict) with:
- apps/web: Next.js App Router, Tailwind, shadcn/ui initialised, next-intl with en/ur,
  a placeholder home page, /api/* rewrite to API_INTERNAL_URL
- apps/api: NestJS on port 4000 with GET /health and Swagger at /docs
- apps/worker: NestJS standalone app that boots and logs "worker ready"
- packages/db (move the existing prisma folder and tests here; add scripts db:migrate, db:seed,
  test:constraints), packages/shared, packages/api-client, packages/templates
  (empty, with package.json named @venueos/*)
- Shared configs: tsconfig base, ESLint (including a rule banning @prisma/client imports
  outside packages/db and banning dangerouslySetInnerHTML), Prettier
- docker-compose.yml with postgres:16 and mailpit (already in the repo, adjust if needed)
- Root scripts: dev, build, lint, typecheck, test
Acceptance: pnpm install && pnpm dev starts all three apps; pnpm lint and pnpm typecheck pass;
GET localhost:4000/health returns 200.
Do not implement auth or business modules yet.
```
