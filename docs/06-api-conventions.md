# 06 — API conventions

## Style

- REST over JSON, base path `/v1`. Plural nouns: `/v1/bookings`, `/v1/bookings/{id}/sessions`.
  Health and docs live outside `/v1`: `GET /health`, `GET /health/ready`, `/docs` (dev only).
- State changes that are not plain field edits are action endpoints:
  `POST /v1/bookings/{id}/hold`, `/confirm`, `/cancel`, `/restore`;
  `POST /v1/bookings/{id}/sessions/{sessionId}/cancel`;
  `POST /v1/payments/{id}/reverse`, `POST /v1/payments/{id}/clear` (cheques);
  `POST /v1/refunds` (request), `POST /v1/refunds/{id}/approve`, `/reject`;
  `POST /v1/expenses/{id}/reverse`.
- `GET` list, `GET /{id}` read, `POST` create, `PATCH` partial update. No `PUT`.
  `DELETE` only for catalogue items, and it sets `active = false`. Bookings, payments,
  expenses, inventory movements and audit rows have no delete endpoint at all.
- JSON fields in camelCase. Money as strings **with the currency's own number of decimals**
  (`"125000.00"` for PKR, `"12.500"` for KWD, `"5000"` for JPY) to avoid float errors; dates as
  `YYYY-MM-DD`; instants as ISO 8601 UTC (`2027-02-14T14:00:00Z`). Payment/expense `amount` is
  always positive; the entry type carries the meaning.
- Every request and response schema is a Zod schema in `packages/shared/src/schemas/<module>.ts`,
  exported to OpenAPI. The web app uses the generated `packages/api-client`.

## Headers

| Header | Direction | Use |
| --- | --- | --- |
| `Cookie: __Host-vos_session` | → | Staff session (web app) |
| `X-Requested-With: venueos` | → | Required on POST/PATCH/DELETE (CSRF) |
| `Idempotency-Key` | → | Required on `POST /payments`, `/refunds`, `/expenses`, `/inventory/movements`; UUID v4. Stored in `idempotency_key` with `unique(tenant_id, idempotency_key)` on each of those tables |
| `X-Request-Id` | ← | Echoed or generated; include in bug reports |

## Errors

Always this shape, with a stable machine `code`:

```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "Hall A is already booked for this time.",
    "details": { "spaceId": "clx...", "startsAt": "2027-02-14T14:00:00Z" },
    "requestId": "req_01J..."
  }
}
```

| HTTP | Code examples |
| --- | --- |
| 400 | `VALIDATION_ERROR` (details = field errors) |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED` |
| 402 | `PLAN_LIMIT_REACHED` |
| 403 | `FORBIDDEN`, `DISCOUNT_LIMIT`, `TENANT_SUSPENDED` (writes on a read-only tenant) |
| 404 | `NOT_FOUND` (also for other tenants' resources) |
| 409 | `SLOT_TAKEN`, `VERSION_CONFLICT`, `DUPLICATE`, `IDEMPOTENCY_CONFLICT` (same key, different body) |
| 422 | `ADVANCE_REQUIRED`, `LOCAL_RULE`, `INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (no internals in message) |

Messages are user-safe English; the web app maps `code` to translated text.

## Lists

- Cursor pagination: `?limit=25&cursor=<opaque>`; response
  `{ "data": [...], "nextCursor": "..." | null }`. Max `limit` 100.
- Filters as query params (`?status=CONFIRMED&venueId=...&from=2027-02-01&to=2027-02-28`).
- Sort with `?sort=startsAt` / `?sort=-createdAt` from an allowlist per endpoint.

## Concurrency

- Every editable resource returns `rev` (integer, maintained by a database trigger on every
  update); `PATCH` and action endpoints that edit it must send `rev` back. Mismatch →
  `409 VERSION_CONFLICT`. The service updates `WHERE id = $1 AND rev = $2`.
- `bookings.quoteVersion` is the **price** version and is not a concurrency token.
- Calendar conflicts are decided by the database constraint and surface as `409 SLOT_TAKEN`.
- Inventory stock never going negative is decided by the database CHECK and surfaces as
  `422 INSUFFICIENT_STOCK`.

## Versioning

Breaking changes go to `/v2` for the public API only. The web app and API deploy together,
so internal changes ship with the regenerated client in the same PR.
