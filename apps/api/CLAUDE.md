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
- Never run git commit/push/merge/rebase/branch commands; list changed files and suggest a
  conventional commit message at the end.
