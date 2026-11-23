# 06 — API conventions

## Style

- REST over JSON, base path `/v1`. Plural nouns: `/v1/bookings`, `/v1/bookings/{id}/sessions`.
- State changes that are not plain field edits are action endpoints:
  `POST /v1/bookings/{id}/hold`, `/confirm`, `/cancel`, `/restore`;
  `POST /v1/payments/{id}/reverse`; `POST /v1/refunds/{id}/approve`.
- `GET` list, `GET /{id}` read, `POST` create, `PATCH` partial update. No `PUT`.
  `DELETE` only for catalogue items, and it sets `active = false`.
- JSON fields in camelCase. Money as strings with 2 decimals (`"125000.00"`) to avoid float
  errors; dates as `YYYY-MM-DD`; instants as ISO 8601 UTC (`2027-02-14T14:00:00Z`).
- Every request and response schema is a Zod schema in `packages/shared/src/schemas/<module>.ts`,
  exported to OpenAPI. The web app uses the generated `packages/api-client`.

## Headers

| Header | Direction | Use |
| --- | --- | --- |
| `Cookie: __Host-vos_session` | → | Staff session (web app) |
| `X-Requested-With: venueos` | → | Required on POST/PATCH/DELETE (CSRF) |
| `Idempotency-Key` | → | Required on `POST /payments`, `/refunds`, `/expenses`, `/inventory/movements`; UUID v4 |
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
| 403 | `FORBIDDEN`, `DISCOUNT_LIMIT` |
| 404 | `NOT_FOUND` (also for other tenants' resources) |
| 409 | `SLOT_TAKEN`, `VERSION_CONFLICT`, `DUPLICATE` |
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

- Editable resources return `version` (or `updatedAt`); `PATCH` must send it back.
  Mismatch → `409 VERSION_CONFLICT`.
- Calendar conflicts are decided by the database constraint and surface as `409 SLOT_TAKEN`.

## Versioning

Breaking changes go to `/v2` for the public API only. The web app and API deploy together,
so internal changes ship with the regenerated client in the same PR.
