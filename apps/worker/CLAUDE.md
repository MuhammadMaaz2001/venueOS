# apps/worker — job rules

- Jobs live in `src/jobs/<name>.job.ts` and extend the base job class.
- Payload always carries `tenantId`; the job body runs inside `TenantDb.tx()` for that tenant
  as the `venueos_app` role.
- Scanners (finding due work across tenants) use the `venueos_jobs` connection, read IDs only,
  and enqueue one job per item.
- Jobs must be idempotent (safe to run twice): check state before acting, use singleton keys.
- Retries: exponential backoff, max 5; then dead-letter. Never swallow errors silently.
- Log with `jobId`, `tenantId`; never log email bodies or PII.
