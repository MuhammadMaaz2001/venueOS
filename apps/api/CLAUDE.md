# apps/api — NestJS API rules

- Module per feature in `src/modules/<module>/`; layout in `docs/07-coding-standards.md`.
- Every controller method: `@RequirePermission('<name>')` or `@Public()`; Zod DTOs from
  `@venueos/shared`; Swagger decorators generated from the Zod schema.
- Database access only via `TenantDb.tx(fn)` from `@venueos/db`. Never `new PrismaClient()`.
  Only `AuthModule` uses `AuthDb` (role `venueos_auth`) for the auth tables.
- Context (`tenantId`, `userId`, `permissions`, `venueIds`, `limits`) comes from CLS, never from
  the request body.
- `TenantGuard`: `SUSPENDED` tenants are read-only (GET allowed, other methods `403 TENANT_SUSPENDED`).
- Any client-supplied ID not covered by a composite FK (venue, package, add-on, vendor, role…)
  is loaded through `TenantDb` first; not found → 404.
- Slow work (email, PDF) → enqueue a pg-boss job inside the same transaction.
- Map `space_occupancies_no_overlap` violations to `SlotTakenError` → 409 `SLOT_TAKEN`, and
  `inventory_items_on_hand_nonneg` to 422 `INSUFFICIENT_STOCK`. Never write
  `space_occupancies.active`; triggers derive it.
- Money: payments/expenses are append-only; fix with a `REVERSAL` entry. `Idempotency-Key` is
  required on payments, refund requests, expenses and inventory movements.
- Editable resources: `PATCH` sends `rev`; update `WHERE id = $1 AND rev = $2`, mismatch → 409
  `VERSION_CONFLICT`.
- Write `AuditService.record()` in the same transaction for every audited action
  (`docs/04-security.md` §8).
- Integration test per endpoint: 2xx, 400, 403, other-tenant 404.

## Foundation (P0-3), what every module builds on

- **Errors:** throw the classes in `src/common/errors/domain-errors.ts` (`NotFoundError`,
  `SlotTakenError`, …); the one `AllExceptionsFilter` renders the docs/06 body. Messages must be
  user-safe; never put SQL, other tenants' ids or stack traces in one. New machine codes go into
  `ERROR_CODES` in `packages/shared/src/errors.ts` first. DB constraint errors are translated in
  `common/errors/db-errors.ts` (only `space_occupancies_no_overlap` so far).
- **Logging:** inject `PinoLogger` from `nestjs-pino` (`logger.info({ fields }, 'message')`), not Nest's
  `Logger` (its second string argument is a context, not a message). `requestId`, `tenantId` and
  `userId` are added automatically from CLS. Never log bodies, headers, tokens or full phone/email;
  the redaction list is a safety net in `common/logging/redaction.ts`, not a licence.
- **Context:** `RequestContext` (`common/context/request-context.ts`) is the typed CLS store. Guards
  set `userId` / `tenantId`; services read them from `ClsService`, never from `req`.
- **Guards run in registration order** in `app.module.ts`, following docs/02: throttler, `CsrfGuard`,
  `AuthGuard`, `TenantGuard`, `PermissionGuard`, `EntitlementGuard`. Never reorder them.
  - `AuthGuard` asks the `AuthContextProvider` (a DI token; P0-4 provides the real one) for
    `AuthContext { userId, sessionId, activeTenantId }`. Nothing else in the app decides who a caller is.
  - `TenantGuard` loads membership + role through `TenantDb`, enforces tenant status (SUSPENDED read-only,
    CANCELLED closed) and fills `access` (`permissions`, `venueIds`, `limits`) and `tenantId` in CLS. It runs
    on every request, nothing is cached.
  - `PermissionGuard` reads `@RequirePermission(<Permission>)` (typed from `@venueos/shared`).
    `@Entitlement('maxVenues' | 'maxSpaces' | 'maxUsers')` on a create endpoint enables the plan-limit check
    (402); the service that must be strict re-checks in its own transaction.
  - `VenueScope` (inject it): `assertAccess(venueId)` -> 404 outside the caller's venues, `filterIds(requested)`
    for lists. A `venueId` from the client only narrows, never widens.
  - Route-scan test (`__tests__/route-scan.spec.ts`): every handler has exactly one of `@Public()` or
    `@RequirePermission()`. A new controller is covered automatically; do not register test controllers in
    production modules.
- **Audit:** `AuditService.record(tx, { action, entityType, entityId, before?, after? })` inside the same
  `TenantDb.tx` as the change (actor, tenant and IP from CLS; `actor: 'SYSTEM'` + `tenantId` for jobs).
  `before` / `after` are masked (`common/audit/mask-sensitive.ts`) but pass only the fields that matter.
- **Roles module** (`modules/roles`) is the reference for a CRUD module: DTOs from `@venueos/shared`, service
  with `TenantDb` + `AuditService`, `rev` checks, `404` for other tenants' ids, escalation guard.
- **Config:** read settings from the injected `APP_CONFIG` (validated env), never `process.env`.
- **Tests:** `src/__tests__/helpers/create-test-app.ts` boots the real app (same `configureApp`) with
  test-only probe controllers and an in-memory log stream. Integration specs are `*.int-spec.ts`. They run
  against ONE throwaway, fully migrated Postgres per run (`test/global-setup.mjs`: needs the docker Postgres
  and `VENUEOS_TEST_ADMIN_URL`, as for `test:constraints`), connected as `venueos_app`, so RLS and grants
  apply. Build fixtures with `World` (`helpers/world.ts`: tenants, default roles, members, venues) and act as
  a user with `t.as(authHeader(userId, tenantId))`. The identity stub (`helpers/test-auth.ts`) is test-only:
  it must never be imported by application code (`no-test-auth.spec.ts` enforces it).
  Controllers with constructor injection need no `@Inject` because vitest compiles with SWC.
- Changing endpoints or schemas: run `pnpm api-client:generate` and commit
  `packages/api-client/openapi.json` and `src/schema.ts`.
- Never run git commit/push/merge/rebase/branch commands; list changed files and suggest a
  conventional commit message at the end.
