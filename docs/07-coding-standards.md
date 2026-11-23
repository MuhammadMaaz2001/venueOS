# 07 — Coding standards

## General

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`. No `any` (use `unknown` and
  narrow). No non-null `!` except in tests.
- ESLint + Prettier shared config at the root; CI fails on warnings.
- Names: files `kebab-case.ts`, classes `PascalCase`, functions/variables `camelCase`,
  constants `SCREAMING_SNAKE_CASE`, DB tables **and columns** `snake_case` (Prisma `@@map` /
  `@map`; Prisma fields stay `camelCase`).
- One concept per file; no file over ~300 lines without a reason.
- Comments explain *why*, not *what*. Business rules reference the section in
  `docs/05-business-rules.md` (e.g. `// Rule 3.2: price rules order`).
- No magic numbers for tenant-configurable values: read them from tenant settings.

## Pinned versions and why

Every dependency is pinned to an exact version (`.npmrc` has `save-exact=true`; no `^`, `~` or
`latest`). Node 24 and pnpm 12.21.0 are fixed through `engines` and `packageManager`. Several
pins are **not** the newest release on purpose. Do not bump these without checking the peer
ranges named here (`npm view <pkg>@<version> peerDependencies`):

| Package | Pinned | Why not newer |
| --- | --- | --- |
| `@nestjs/*` (core, common, platform-express, testing) | 11.2.11 | `nestjs-zod` 5.6.0 declares peers `@nestjs/common` `^10 \|\| ^11` and `@nestjs/swagger` `^7.4.2 \|\| ^8 \|\| ^11`. NestJS 12 is outside that range. |
| `@nestjs/swagger` | 11.4.8 | Must match the Nest major and the `nestjs-zod` peer range above. |
| `@nestjs/cli` | 11.0.24 | Same major as the framework. |
| `typescript` | 6.0.3 | `typescript-eslint` 8.73.0 supports `>=4.8.4 <6.1.0`, so TypeScript 7 breaks linting. |
| `eslint` | 9.39.5 | `eslint-config-next` 16 targets ESLint 9; ESLint 10 is not yet supported by every plugin it pulls in. |
| `prisma`, `@prisma/adapter-pg` | 7.10.1 | The npm `latest` tag is the 8.0.0 release candidate. The project is on Prisma 7 (`prisma.config.ts`, `prisma-client` generator, driver adapter). All Prisma packages move together. |
| `nestjs-zod` | 5.6.0 | Added in P0-3. It is the constraint behind the NestJS and swagger pins. |

Upgrade path: raise the dependency that limits the others first (for example wait for a
`nestjs-zod` release that lists the next Nest major), change the pins together in one PR, and run
`pnpm lint && pnpm typecheck && pnpm test` plus `pnpm --filter @venueos/db test:constraints`.
Allowed install scripts are listed in `pnpm-workspace.yaml` (`allowBuilds`); a new dependency that
needs one must be reviewed before it is added there.

## API (NestJS) module layout

```
apps/api/src/modules/bookings/
├── bookings.module.ts
├── bookings.controller.ts        # HTTP only: decorators, validation, call service
├── bookings.service.ts           # business logic, transactions via TenantDb
├── booking-state.ts              # state machine (pure functions, unit-tested)
├── pricing/                      # pricing engine (pure, unit-tested)
├── bookings.repository.ts        # optional: complex queries
└── __tests__/
    ├── booking-state.spec.ts
    └── bookings.int-spec.ts      # integration tests against a real Postgres
```

- Controllers never touch the database. Services never read `req`; context comes from CLS.
- Pure logic (state transitions, pricing, schedules, refunds) lives in pure functions with
  no I/O, so it is trivially unit-tested.
- Throw typed domain errors (`SlotTakenError`, `AdvanceRequiredError`); one exception filter
  maps them to the API error format.

## Web (Next.js) layout

```
apps/web/src/
├── app/(auth)/...                # login, invite, reset
├── app/(app)/[module]/...        # dashboard routes
├── features/<module>/            # components, hooks, query keys, forms
├── components/ui/                # shadcn/ui primitives (generated, lightly edited)
├── lib/                          # api client setup, formatting, i18n
└── messages/{en,ur}.json         # translations
```

- Data fetching only through hooks in `features/<module>/api.ts` wrapping
  `packages/api-client` with TanStack Query.
- Forms: react-hook-form + `zodResolver` with schemas from `packages/shared`.
- Money and dates are formatted only through `lib/format.ts` (tenant currency, venue timezone,
  locale).
- Every user-facing string goes through next-intl; no hard-coded text.
- Accessibility: labels on inputs, keyboard-usable dialogs, colour is never the only signal
  (calendar cells also show an icon/text).

## Testing

| Level | Tool | What |
| --- | --- | --- |
| Unit | Vitest | Pricing, state machine, schedules, refunds, formatting |
| Integration | Vitest + Testcontainers (Postgres) + Supertest | Every endpoint: happy path, 400, 403, other-tenant 404, key conflicts |
| DB constraints | `packages/db/tests/db-constraints.test.mjs` (`node --test`) | Runs on the **real migrated schema** in a throwaway database (Docker/CI Postgres, as the non-superuser migrator): exclusion constraint, occupancy triggers, composite FKs, RLS, auth-table and append-only privileges, CHECKs |
| E2E | Playwright | Golden paths: setup wizard, lead → quotation → hold → confirm → payment → receipt, event sheet |

- Tests create their own tenant(s) with factories; never depend on seed data.
- Coverage target: 90% for `pricing/` and `booking-state.ts`; no global target.

## Git workflow

- **The developer does all git operations** (branches, commits, pushes, merges, PRs).
  Claude Code never runs `git commit`, `push`, `merge`, `rebase` or branch commands and never
  opens PRs; it may run read-only commands (`status`, `diff`, `log`) and ends every task by
  listing the changed files and suggesting a conventional commit message.
- `main` is always deployable; protected; PR + green CI required.
- Branches: `feat/<module>-<short>`, `fix/<short>`, `chore/<short>`.
- Conventional commits; squash merge.
- PR description: what and why, screenshots for UI, migration notes, the security checklist
  from `04-security.md`.
- Migrations are forward-only. A destructive change ships in two steps (expand, then contract)
  so a rollback of the app never needs a DB rollback.

## Working with Claude Code

- Give one module (or one slice of it) per task, with the acceptance criteria from
  `01-product-scope.md` and the rules from `05-business-rules.md`.
- Ask for tests first on logic-heavy work (pricing, states, refunds), then the implementation.
- Before a task is reported done, Claude Code runs `pnpm lint && pnpm typecheck && pnpm test`
  (and `pnpm --filter @venueos/db test:constraints` when `packages/db` changed), fixes every
  failure, and never disables a lint rule or skips a test to get green. These scripts exist from
  P0-1 onward.
- Review every migration and every new `@Public()` route by hand.
