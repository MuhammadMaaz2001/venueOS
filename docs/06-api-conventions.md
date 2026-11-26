# 06 — API conventions

## Style

- REST over JSON, base path `/v1`. Plural nouns: `/v1/bookings`, `/v1/bookings/{id}/sessions`.
  Health and docs live outside `/v1`: `GET /health`, `GET /health/ready`, `/docs` (off in production unless `SWAGGER_ENABLED=true`).
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
| 403 | `FORBIDDEN` (login with an unverified address: `details.reason = EMAIL_NOT_VERIFIED`), `CSRF_REJECTED` (missing `X-Requested-With` / wrong `Origin`), `DISCOUNT_LIMIT`, `TENANT_SUSPENDED` (writes on a read-only tenant) |
| 404 | `NOT_FOUND` (also for other tenants' resources) |
| 409 | `SLOT_TAKEN`, `VERSION_CONFLICT`, `DUPLICATE`, `IDEMPOTENCY_CONFLICT` (same key, different body) |
| 422 | `ADVANCE_REQUIRED`, `LOCAL_RULE`, `INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION` |
| 429 | `RATE_LIMITED` (with `Retry-After`; login from an IP with 20 attempts in 15 minutes) |
| 500 | `INTERNAL` (no internals in message) |

Other 4xx from the framework (malformed JSON, oversized body, unknown route) use `BAD_REQUEST`,
`PAYLOAD_TOO_LARGE`, `METHOD_NOT_ALLOWED` or `NOT_FOUND` with fixed messages. `GET /health/ready` is the
one endpoint that is not an error envelope: it answers `503 {"status":"unavailable","checks":{...}}`
for load balancers.

Messages are user-safe English; the web app maps `code` to translated text.

## Auth endpoints (P0-4)

| Endpoint | Access | Notes |
| --- | --- | --- |
| `POST /v1/auth/signup` | public | always `202 { message }` (same for existing addresses) |
| `POST /v1/auth/verify-email` | public | `{ token }` → 204; invalid/expired/used → 400 |
| `POST /v1/auth/resend-verification` | public | `{ email }` → 202 generic |
| `POST /v1/auth/login` | public | sets the cookie; `{ user, activeTenantId, tenants }`; one generic 401 |
| `POST /v1/auth/password/forgot` | public | `{ email }` → 202 generic |
| `POST /v1/auth/password/reset` | public | `{ token, newPassword }` → 204; ends every session |
| `POST /v1/auth/invitations/accept` | public | `{ token, name, password }` for a NEW user; existing address → 409 |
| `POST /v1/auth/logout`, `/logout-all` | login | 204, clears the cookie |
| `POST /v1/auth/password/change` | login | `{ currentPassword, newPassword }` → 204; ends the other sessions |
| `GET /v1/me`, `GET /v1/me/tenants` | login | identity, permissions of the active workspace; active memberships. A workspace (`TenantSummary`) carries `country`, `currency`, `timezone` and `defaultLocale`, which the web app formats money and dates with |
| `POST /v1/me/switch-tenant` | login | `{ tenantId }`; rotates the cookie; not a member → 404 |
| `POST /v1/me/invitations/accept` | login | `{ token }` for an existing account |
| `GET/POST /v1/staff/invitations`, `DELETE /v1/staff/invitations/{id}` | `staff.manage` | create also needs room in the plan |
| `GET /v1/staff`, `PATCH /v1/staff/{membershipId}` | `staff.manage` | `rev`; one active Owner always remains (422) |
| `GET /v1/staff/assignable-roles` | `staff.manage` | `{ data: [{ id, name }] }`: the roles the caller may give (no escalation); does not need `role.manage` (the invite and edit pickers of the web app) |

## Roles and audit (module 2)

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET /v1/roles?status=active\|retired\|all` | `role.manage` | default `active`; each role has `active` and `memberCount` (active members) |
| `POST /v1/roles` | `role.manage` | `{ name, copyFromRoleId }`; a retired source is 422 |
| `PATCH /v1/roles/{id}` | `role.manage` | `rev` + any of `name`, `permissions`, `limits`, `active`; `<area>.manage` without `<area>.view` is 400; retiring a role with active members or a system role is 422; a retired role only accepts `active: true` |
| `GET /v1/audit-logs` | `audit.view` | cursor list, newest first; filters `entityType`, `entityId`, `actorUserId`, `action`, `from`, `to` (`YYYY-MM-DD` = whole tenant-time-zone days, inclusive, or an ISO instant); venue-limited callers see only their venues' entries |
| `GET /v1/audit-logs/{id}` | `audit.view` | with `before`, `after`, `ip`; another tenant's or an out-of-scope id is 404 |

## Catalogue and pricing (module 3)

All of these are tenant-wide lists (`{ data, nextCursor: null }`, `?includeInactive=true` shows deactivated rows), `PATCH`
with `rev`, `active: false` as the delete, no `DELETE`. A write needs access to all venues (403 otherwise), except price rules
scoped to a space or slot of the caller's venues.

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET/POST /v1/menu-items`, `GET/PATCH /v1/menu-items/{id}` | `catalogue.view` / `catalogue.manage` | `?category=`; names unique among active (409) |
| `GET/POST /v1/packages`, `GET/PATCH /v1/packages/{id}` | `catalogue.view` / `catalogue.manage` | `items` replaces the whole dish list on PATCH; `perHeadRate` is `null` without `catalogue.manage` or `booking.view_prices`; another tenant's dish is 404 |
| `GET/POST /v1/add-ons`, `GET/PATCH /v1/add-ons/{id}` | `catalogue.view` / `catalogue.manage` | `pricing` FIXED, PER_HEAD, PER_HOUR, PER_UNIT; `price` hidden like `perHeadRate` |
| `GET/POST /v1/custom-fields`, `GET/PATCH /v1/custom-fields/{id}` | `catalogue.view` / `catalogue.manage` | `?entity=`; key unique per entity for good (409); entity, key, type, sensitive fixed |
| `GET/POST /v1/price-rules`, `GET/PATCH /v1/price-rules/{id}` | `pricing.view` / `pricing.manage` | `?spaceId=`, `?slotId=`; the merged rule is validated on PATCH; space and slot of another tenant are 404, of different venues 400 |
| `GET /v1/pricing/rent-preview?venueId&spaceId&slotId&date[&hours]` | `pricing.view` | base rent, each rule in the order applied (`adjustments`), overrides that lost (`notApplied`), `finalRent`; HOURLY needs `hours`; 400 slot not offered that weekday, 422 no rent set |
| `GET/POST /v1/tax-rates`, `GET/PATCH /v1/tax-rates/{id}` | `pricing.view` / `pricing.manage` | `isDefault: true` moves the default flag; deactivating the default clears it |
| `GET/POST /v1/cancellation-policies`, `GET/PATCH /v1/cancellation-policies/{id}` | `pricing.view` / `pricing.manage` | tiers: `minDaysBefore` strictly descending, last one 0, `refundPct` 0..100; default as for tax rates |

## Customers and leads (modules 4 and 5)

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET /v1/customers?search&includeInactive&limit&cursor` | `customer.view` | cursor list ordered by name; `search` matches name, phone (digits, with or without the leading zero) and email |
| `GET /v1/customers/duplicates?phone&email&excludeId` | `customer.view` | other active customers with the same phone / alternative phone / email; 400 without phone or email |
| `POST /v1/customers` | `customer.manage` | phone read with the workspace country; the answer lists `duplicates`; custom fields validated against the definitions (type, choices, required); a sensitive value is sealed |
| `GET /v1/customers/{id}` | `customer.view` | profile, masked custom fields (`sensitiveKeys`), `leads` (needs `lead.view`, caller's venues), `duplicates` |
| `PATCH /v1/customers/{id}` | `customer.manage` | `rev`; custom fields: only the keys sent change, `null` clears; `active: false` is the delete |
| `POST /v1/customers/{id}/reveal/{fieldKey}` | `customer.view_sensitive` | `{ key, value }`, audited; 404 for a field that is not sensitive or has no value |
| `GET /v1/leads?venueId&stage&assigneeId&unassigned&source&customerId&followUp=overdue\|today&search&limit&cursor` | `lead.view` | newest first; only the caller's venues |
| `GET /v1/leads/follow-ups?assignee=me\|any&limit` | `lead.view` | `{ overdue, dueToday, items }` for the dashboard card |
| `GET /v1/leads/assignees?venueId` | `lead.view` | active members with `lead.manage` whose venues cover the venue |
| `POST /v1/leads` | `lead.manage` | `customerId` or an inline `customer` (needs `customer.manage`); `nextFollowUpAt` required; starts NEW; assignee defaults to the caller |
| `GET /v1/leads/{id}` | `lead.view` | out-of-scope venue = 404 |
| `PATCH /v1/leads/{id}` | `lead.manage` | `rev`; `stage` (+ `lostReason` for LOST, `nextFollowUpAt` when reopening); illegal change 422 `INVALID_STATE_TRANSITION`; ineligible assignee 400, unknown member 404 |
| `GET /v1/leads/{id}/activity` | `lead.view` | `{ data: [{ action, actorName, createdAt, changes: [{ field, from, to }] }] }`, newest first |

## Availability, quotations and bookings (modules 6-8)

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET /v1/availability?venueId&from&to` | `booking.view` | at most 62 days; `{ spaces, slots, cells }`, only taken cells are listed (status `HELD` or `CONFIRMED`, with booking number, customer name, event type, hold expiry; combined spaces show which physical space blocks them); no prices; venue outside the caller's venues = 404 |
| `POST /v1/quotations/preview` | `quotation.manage` + `booking.view_prices` | the same body as create without saving: lines, totals, tax, `maxDiscountPct`, `warnings` (`SLOT_TAKEN`, `LOCAL_RULE`); 403 `DISCOUNT_LIMIT` |
| `POST /v1/quotations` | `quotation.manage` | `venueId`, `customerId` or `leadId`, `sessions[]` (space, date, slot, times for HOURLY, event type, package, guests, guaranteed guests, add-ons, notes), `discount`, `cancellationPolicyId`, `notes`; creates the DRAFT booking and version 1, queues the PDF, lead -> QUOTED; 201 |
| `GET /v1/quotations?bookingId&customerId&leadId` | `quotation.manage` | cursor list of versions |
| `GET /v1/quotations/{id}` | `quotation.manage` | the frozen version (`pdfReady`, `isLatest`, `sentAt`, `acceptedAt`) |
| `POST /v1/quotations/{id}/send` | `quotation.send` | `{ to?, message? }`; 422 until the PDF is ready; email with the PDF attached |
| `POST /v1/quotations/{id}/accept` | `quotation.manage` | records that the customer accepted this version |
| `GET /v1/quotations/{id}/pdf` | `quotation.send` | `{ url, expiresInSeconds }`: a pre-signed link of 5 minutes |
| `GET /v1/quotations/{id}/whatsapp` | `quotation.send` | `{ url, text }`: a `wa.me` link with a text summary |
| `GET /v1/bookings?status&venueId&customerId&leadId&from&to&search&limit&cursor` | `booking.view` | newest first; amounts are `null` without `booking.view_prices` |
| `GET /v1/bookings/{id}` | `booking.view` | sessions, lines, totals, warnings, quotation versions, cancellation snapshot, timeline of audit entries |
| `PATCH /v1/bookings/{id}` | `booking.edit` | `rev`; `notes`, `discount`, `cancellationPolicyId`, `sessions` (DRAFT only), `requote` |
| `POST /v1/bookings/{id}/hold` | `booking.hold` | `{ rev, overrideRules?, reason? }`; DRAFT -> TENTATIVE, number assigned; 409 `SLOT_TAKEN`, 422 `LOCAL_RULE` |
| `POST /v1/bookings/{id}/extend-hold`, `/rehold` | `booking.hold` (a second extension: `booking.extend_hold`) | `{ rev }` |
| `POST /v1/bookings/{id}/confirm` | `booking.confirm` | `{ rev, override?, reason? }`; 422 `ADVANCE_REQUIRED`; the override needs `booking.confirm_override` |
| `POST /v1/bookings/{id}/cancel` | `booking.cancel` | `{ rev, reason }`; answers the booking and `refund` (suggested, from the policy snapshot) |
| `POST /v1/bookings/{id}/restore` | `booking.cancel` | `{ rev }`; 409 `SLOT_TAKEN` when the slot is gone |
| `POST /v1/bookings/{id}/sessions`, `PATCH .../sessions/{sessionId}`, `POST .../sessions/{sessionId}/cancel` | `booking.edit` (`booking.edit_locked` inside the guest lock window) | `rev`; re-prices at the frozen rates unless `requote: CURRENT` |

Every booking route takes the booking's `rev` and answers `409 VERSION_CONFLICT` when it moved on. Actions answer `200`.

## Payments, refunds and receivables (module 9)

Every request that creates a payment, a reversal, a refund request or a refund payment needs an `Idempotency-Key` header; a retry returns the first result with `200` (201 the first time).

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET /v1/bookings/{id}/payments` | `payment.view` | `summary` (paid total = cleared net, pending cheques, credit, balance, advance, `readyToConfirm`, suggested and possible refund), `schedule` (items with their FIFO status), `payments` (every entry), `refundRequests` |
| `POST /v1/bookings/{id}/payments` | `payment.record` | `{ method, amount, reference?, receivedAt?, notes? }`; a cheque needs `reference` and starts PENDING; 422 for a quotation, expired or cancelled booking |
| `PUT /v1/bookings/{id}/payment-schedule` | `payment.record` | `{ items: [{ label, dueDate, amount }] }`; must add up to the grand total (400); 422 unless held or confirmed |
| `POST /v1/payments/{id}/clear` | `payment.record` | a pending cheque becomes CLEARED |
| `POST /v1/payments/{id}/bounce` | `payment.record` | `{ reason? }`; a received cheque, PENDING or CLEARED, becomes BOUNCED |
| `POST /v1/payments/{id}/reverse` | `payment.reverse` | `{ reason }`; a new REVERSAL entry; a cleared receipt, once |
| `GET /v1/payments/{id}/receipt` | `payment.view` | `{ url, expiresInSeconds }` pre-signed (5 minutes); 422 while the PDF is being made |
| `POST /v1/payments/{id}/receipt/resend` | `payment.record` | `{ to? }`; 422 for a payment that has not cleared or a customer without an address |
| `POST /v1/bookings/{id}/refund-requests` | `payment.refund.request` | `{ amount, reason }`; up to what was paid and is not already being refunded (422) |
| `GET /v1/refund-requests?status&bookingId&limit&cursor` | `payment.view` | newest first; the queue |
| `POST /v1/refund-requests/{id}/approve`, `/reject` | `payment.refund.approve` | `{ rev, note? }` (reject: `note` required); not the requester's own unless they are the one approver (403) |
| `POST /v1/refund-requests/{id}/pay` | `payment.record` | `{ rev, method, reference?, notes? }`; writes the REFUND payment; the request becomes PAID (a cheque: when it clears) |
| `GET /v1/receivables?venueId&from&to&overdue&limit&cursor` | `payment.view` | confirmed and completed bookings with a balance, overdue first |
| `GET /v1/receivables/summary` | `payment.view` | `dueThisWeek`, `overdue`, `outstanding` (count and amount): the dashboard cards |

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
