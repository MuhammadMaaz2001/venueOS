# apps/api — NestJS API rules

- Module per feature in `src/modules/<module>/`; layout in `docs/07-coding-standards.md`.
- Every controller method: `@RequirePermission('<name>')` or `@Public()`; Zod DTOs from
  `@venueos/shared`; Swagger decorators generated from the Zod schema.
- Database access only via `TenantDb.tx(fn)` from `@venueos/db`. Never `new PrismaClient()`.
- Context (`tenantId`, `userId`, `permissions`, `venueIds`, `limits`) comes from CLS, never from
  the request body.
- Slow work (email, PDF) → enqueue a pg-boss job inside the same transaction.
- Map `space_occupancies_no_overlap` violations to `SlotTakenError` → 409 `SLOT_TAKEN`.
- Write `AuditService.record()` in the same transaction for every audited action
  (`docs/04-security.md` §8).
- Integration test per endpoint: 2xx, 400, 403, other-tenant 404.
