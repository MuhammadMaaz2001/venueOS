# venueOS — instructions for Claude Code

venueOS is a multi-tenant SaaS for event venues (marriage halls, banquets, lawns, marquees,
hotel banquets). One tenant = one venue business. Pakistan first (PKR, English/Urdu), but
nothing in the code may assume a country, currency, language or venue type.

Read before non-trivial work:
- `docs/01-product-scope.md` — what the MVP includes and excludes
- `docs/02-system-design.md` — architecture, request flow, modules
- `docs/04-security.md` — security rules (mandatory)
- `docs/05-business-rules.md` — booking, pricing, payment, inventory rules
- `docs/03-data-model.md` + `packages/db/prisma/schema.prisma` — the data model

## Stack

- Monorepo: pnpm workspaces + Turborepo, Node 24 LTS, TypeScript strict everywhere
- `apps/web`: Next.js (App Router), Tailwind, shadcn/ui, TanStack Query, react-hook-form + Zod, next-intl
- `apps/api`: NestJS REST API (`/v1`), Zod validation (`nestjs-zod`), OpenAPI via `@nestjs/swagger`
- `apps/worker`: NestJS standalone app running pg-boss jobs
- `packages/db`: Prisma schema, migrations, SQL constraints/RLS, tenant-scoped client
- `packages/shared`: Zod schemas, enums, permission names, money/date helpers (no server code)
- `packages/api-client`: typed client generated from the API's OpenAPI spec
- `packages/templates`: email and PDF HTML templates (quotation, receipt, event sheet)
- PostgreSQL 16+ with btree_gist; email via AWS SES behind an `EmailProvider` interface

## Commands

```bash
pnpm install
pnpm dev                 # web :3000, api :4000, worker
pnpm build
pnpm lint && pnpm typecheck
pnpm test                # unit + integration
pnpm --filter @venueos/db test:constraints   # double-booking + RLS tests on a throwaway Postgres
pnpm db:migrate          # prisma migrate dev
pnpm db:seed
pnpm api-client:generate # regenerate typed client after any API change
```

## Non-negotiable rules

1. **Tenant isolation.** Every query on tenant data goes through `TenantDb` (`packages/db`),
   which runs it in a transaction that sets `app.tenant_id` / `app.user_id`. Never import or
   instantiate `PrismaClient` in a feature module. Never accept `tenantId` from the request
   body or query: it comes from the session (staff) or `resolve_tenant(host)` (public pages).
2. **Every endpoint declares access.** Staff endpoints use `@RequirePermission('<permission>')`
   with names from `packages/shared/src/permissions.ts`. Public endpoints are marked
   `@Public()` explicitly and reviewed. No endpoint without one of the two.
3. **Validate all input** with a Zod schema from `packages/shared`. Never trust client totals,
   prices, statuses or IDs of other tenants; recompute prices on the server.
4. **Money** is `Decimal` (Prisma) / `decimal.js` in code, never JS `number`. Round only at line
   level to the tenant currency's minor unit. Store frozen line items on bookings.
5. **Time.** Store instants as `timestamptz` (UTC). Slot times are venue-local `"HH:mm"`; convert
   with the venue's IANA timezone. Never use the server's local time.
6. **Never hard-delete** bookings, payments, expenses, inventory movements or audit rows.
   Payments are immutable: fix mistakes with a reversing entry. Catalogue rows use `active=false`.
7. **Double booking is prevented by the database** (exclusion constraint on
   `space_occupancies`). Do not replace it with an app-level check; catch the constraint
   error (`space_occupancies_no_overlap`) and return `409 SLOT_TAKEN`.
8. **Audit** every state change on bookings, payments, prices, discounts, roles and settings via
   `AuditService.record()` in the same transaction.
9. **Secrets** only from environment variables. Never commit `.env`, keys or real customer data.
   Never log passwords, tokens, cookies, CNIC, full phone numbers or email bodies.
10. **Schema changes** only through Prisma migrations. Raw SQL (constraints, RLS, triggers) goes
    in a migration's `migration.sql`, and `test:constraints` must still pass.
11. **API changes** must update the Zod schema in `packages/shared`, the OpenAPI output and
    regenerate `packages/api-client` in the same change.
12. **Tests.** Each new endpoint gets an integration test covering: happy path, validation error,
    missing permission (403), and another tenant's ID (404). Booking/pricing/payment logic gets
    unit tests.

## How to work in this repo

- Work one module at a time (see `docs/09-phase-0-plan.md` and the module order in
  `docs/01-product-scope.md`). Backend first (schema → service → controller → tests), then
  regenerate the client, then the UI.
- Keep feature code inside its module: `apps/api/src/modules/<module>/` and
  `apps/web/src/features/<module>/`.
- Prefer small PRs. Conventional commits: `feat(bookings): ...`, `fix(payments): ...`.
- If a request conflicts with these rules or the docs, stop and ask instead of working around it.
- When a business rule is unclear, check `docs/05-business-rules.md`; if it is not there, ask and
  then add the answer to that file.
