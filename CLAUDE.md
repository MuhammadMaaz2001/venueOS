# venueOS — instructions for Claude Code

venueOS is a multi-tenant SaaS for event venues (marriage halls, banquets, lawns, marquees,
hotel banquets). One tenant = one venue business. Pakistan first (PKR, English-only MVP; RTL/Arabic planned later via next-intl), Gulf
next (3-decimal currencies), but nothing in the code may assume a country, currency, language
or venue type.

Read before non-trivial work:
- `docs/01-product-scope.md` — what the MVP includes and excludes
- `docs/02-system-design.md` — architecture, request flow, modules
- `docs/04-security.md` — security rules (mandatory; source of truth for permission names)
- `docs/05-business-rules.md` — booking, pricing, payment, inventory rules
- `docs/03-data-model.md` + `packages/db/prisma/schema.prisma` — the data model

## Stack

- Monorepo: pnpm workspaces + Turborepo, Node 24 LTS, TypeScript strict everywhere
- `apps/web`: Next.js (App Router), Tailwind, shadcn/ui, TanStack Query, react-hook-form + Zod, next-intl (no `/[locale]` URL segment)
- `apps/api`: NestJS REST API (`/v1`), Zod validation (`nestjs-zod`), OpenAPI via `@nestjs/swagger`
- `apps/worker`: NestJS standalone app running pg-boss jobs
- `packages/db`: Prisma 7 schema (driver adapter `@prisma/adapter-pg`, `prisma.config.ts`), migrations, SQL constraints/RLS, tenant-scoped client
- `packages/shared`: Zod schemas, enums, permission names, money/date helpers, currency minor-unit map, `TenantSettings` (no server code)
- `packages/api-client`: typed client generated from the API's OpenAPI spec
- `packages/templates`: email and PDF HTML templates (quotation, receipt, event sheet)
- PostgreSQL 16+ with btree_gist; email via AWS SES behind an `EmailProvider` interface

## Commands

```bash
pnpm install
pnpm dev                 # web :3000, api :4000, worker
pnpm build
pnpm lint && pnpm typecheck
pnpm test                # unit + integration (api and db tests need the docker Postgres: docker compose up -d postgres)
pnpm --filter @venueos/db test:constraints   # double-booking, RLS, privilege tests on a Docker/CI Postgres
pnpm db:migrate          # prisma migrate dev (uses MIGRATE_DATABASE_URL, the venueos_migrator role)
pnpm db:seed
pnpm api-client:generate # regenerate typed client after any API change
pnpm --filter @venueos/web e2e   # Playwright journeys (needs docker postgres + mailpit; starts/reuses pnpm dev)
```

## Non-negotiable rules

1. **Tenant isolation.** Every query on tenant data goes through `TenantDb` (`packages/db`),
   which runs it in a transaction that sets `app.tenant_id` / `app.user_id`. Never import or
   instantiate `PrismaClient` in a feature module. Never accept `tenantId` from the request
   body or query: it comes from the session (staff) or `resolve_tenant(host)` (public pages).
   The only other database client is `AuthDb` (role `venueos_auth`), used by `AuthModule`
   alone for the auth tables (`user_credentials`, `auth_sessions`, `auth_tokens`,
   `invitations`, `login_attempts`); `venueos_app` cannot read them.
2. **Every endpoint declares access.** Staff endpoints use `@RequirePermission('<permission>')`
   with names from `packages/shared/src/permissions.ts` (mirrors `docs/04-security.md`). Public
   endpoints are marked `@Public()` explicitly and reviewed. Endpoints that need a login but no tenant
   (`/me`, tenant switch, logout) use `@AuthenticatedOnly()`. Exactly one of the three per endpoint.
3. **Validate all input** with a Zod schema from `packages/shared`. Never trust client totals,
   prices, statuses or IDs of other tenants; recompute prices on the server.
4. **Money** is `Decimal(18,3)` (Prisma) / `decimal.js` in code, never JS `number`. Round only at
   line level to the tenant currency's ISO 4217 minor unit (map in `packages/shared`; PKR 2,
   KWD 3, JPY 0). API money strings use the currency's decimals. Store frozen line items on
   bookings and a frozen snapshot per quotation version.
5. **Time.** Every instant is `timestamptz` (UTC); date-only values are `date`. Slot times and
   opening hours are venue-local `"HH:mm"`; convert with the venue's IANA timezone. Never use
   the server's local time.
6. **Never hard-delete** bookings, sessions, payments, refund requests, expenses, inventory
   movements, message logs or audit rows. This is enforced by the database: `venueos_app` has
   no DELETE on them, and no UPDATE on `payments` (except `status`, `cleared_at`),
   `expenses`, `inventory_movements`, `audit_logs`, `message_logs`. Fix mistakes with a
   reversing entry (`entry_type = REVERSAL`, `reverses_id`). Catalogue rows use `active=false`;
   sessions use `status = CANCELLED`. Never work around a permission error with a different role.
7. **Double booking is prevented by the database** (exclusion constraint on
   `space_occupancies`). Do not replace it with an app-level check; catch the constraint
   error (`space_occupancies_no_overlap`) and return `409 SLOT_TAKEN`. `space_occupancies.active`
   is derived by triggers; never rely on a value you write.
8. **Audit** every state change on bookings, payments, prices, discounts, roles and settings via
   `AuditService.record()` in the same transaction.
9. **Secrets** only from environment variables. Never commit `.env`, keys or real customer data.
   Never log passwords, tokens, cookies, CNIC, full phone numbers or email bodies.
10. **Schema changes** only through Prisma migrations. Raw SQL (constraints, RLS, triggers,
    grants) goes in a migration's `migration.sql`, and `test:constraints` must still pass.
    A new table needs the checklist in `docs/03-data-model.md` (RLS, rev trigger, privilege class).
11. **API changes** must update the Zod schema in `packages/shared`, the OpenAPI output and
    regenerate `packages/api-client` in the same change.
12. **Tests.** Each new endpoint gets an integration test covering: happy path, validation error,
    missing permission (403), and another tenant's ID (404). Booking/pricing/payment logic gets
    unit tests.
13. **Referenced IDs.** The database enforces same-tenant references only for
    booking→customer, session→booking/space, occupancy→session/space and payment→booking
    (composite `(tenant_id, id)` FKs). Every other ID that arrives from a client (venue,
    package, add-on, vendor, role, …) must be loaded through `TenantDb` and found (else 404)
    before it is written anywhere.
14. **Never run git commit, push, merge, rebase or branch commands, and never open PRs.**
    The developer does all git operations. Read-only git commands (`status`, `diff`, `log`)
    are allowed. At the end of a task, list the changed files and suggest a conventional
    commit message.

## How to work in this repo

- Work one module at a time (see `docs/09-phase-0-plan.md` and the module order in
  `docs/01-product-scope.md`). Backend first (schema → service → controller → tests), then
  regenerate the client, then the UI.
- Keep feature code inside its module: `apps/api/src/modules/<module>/` and
  `apps/web/src/features/<module>/`.
- Prefer small PRs. Conventional commits: `feat(bookings): ...`, `fix(payments): ...`
  (you suggest the message; the developer commits).
- If a request conflicts with these rules or the docs, stop and ask instead of working around it.
- When a business rule is unclear, check `docs/05-business-rules.md`; if it is not there, ask and
  then add the answer to that file.
- Before saying a task is done, run `pnpm lint && pnpm typecheck && pnpm test`
  (and `pnpm --filter @venueos/db test:constraints` if anything in packages/db changed).
  Fix every failure. Never report "done" with a failing check, and never disable a lint
  rule or skip a test to make it pass.
  (These scripts exist from P0-1 onward; before that, validate what exists, e.g. the Prisma
  schema and the constraint SQL against a Docker Postgres.)
- **Formatting.** Format files by running `pnpm prettier --write <path>` directly. Never pipe, redirect or
  `tee` a formatter's (or any command's) output into a file that is being formatted or edited: a pipe that
  closes early (`| head`, `| tail -0`) kills the formatter mid-write and leaves the file empty (this truncated a
  spec to 0 bytes in P0-6b). Never silence the formatter's stderr either, so a failure is seen. After a bulk
  format, check `git status` for files that shrank or emptied.
