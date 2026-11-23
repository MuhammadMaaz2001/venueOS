# apps/worker — job rules

- Jobs live in `src/jobs/<name>.job.ts` and extend the base job class.
- Payload always carries `tenantId`; the job body runs inside `TenantDb.tx()` for that tenant
  as the `venueos_app` role.
- Scanners (finding due work across tenants) use the `venueos_jobs` connection (SELECT only on
  tenants, venues, bookings, booking_sessions, payment_schedule_items, leads, inventory_items),
  read IDs only, and enqueue one job per item. Need another table? Add it to the grants in a
  migration with a reason; never widen the role casually.
- Message delivery is an append-only event log (`message_logs`): write a new row per event with
  the same `message_key`, never update.
- The `auth.purge` job is the only worker code that uses `AuthDb`.
- Jobs must be idempotent (safe to run twice): check state before acting, use singleton keys.
- Retries: exponential backoff, max 5; then dead-letter. Never swallow errors silently.
- Log with `jobId`, `tenantId`; never log email bodies or PII.
