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

## Foundation (P0-6a), what every job builds on

- **Base class:** `src/jobs/tenant-job.ts`. A job extends `TenantJob<Payload>`, sets `queue` and `payloadSchema`
  (Zod, must contain `tenantId`) and implements `handle(ctx)`. Register it in `src/jobs/jobs.module.ts` (the
  `JOBS` list). `ctx.tx(fn)` is a `TenantDb` transaction for the payload's tenant (role `venueos_app`),
  `ctx.log` already carries `jobId`, `tenantId`, `queue`, `attempt`.
- **Payloads carry identifiers only** (`tenantId` plus ids such as `messageKey`). `pgboss.job` has no RLS: never put
  names, addresses, amounts or template variables in a payload; keep them on an RLS-protected row and load them
  inside `ctx.tx` (docs/04 section 4).
- **Short transactions:** database work in short `ctx.tx` calls; slow external work (SMTP/SES, S3, Chromium)
  between them, never inside one. See `email-send.job.ts` (load, send, append result).
- **Failures:** throw `RetryableJobError(code)` (or any error: code `UNEXPECTED`) for the retry policy (30 s
  exponential backoff, capped at 1 h, max 5 retries, then `<queue>.dead`). Throw `PermanentJobError(code)` when
  no retry can help: dead-lettered at once. Codes are short fixed strings; never put raw error text in a job
  output, a log line or `message_logs.error`. `describeError()` gives name + code only.
- **Idempotency:** enqueue with a singleton key (`email.send`: the `messageKey`) and check state first (is there
  already a `sent` row?). Delivery is at-least-once.
- **Email:** `email.send` appends to `message_logs` (never updates): `queued` (written by the API), then `sent`, or
  `failed` per attempt (`attempt`, `error` code, `is_final` on the last). Providers: `SmtpEmailProvider`
  (Mailpit), `SesEmailProvider`; chosen by `EMAIL_PROVIDER`. Templates come from `@venueos/templates`
  (`renderEmail`), which escapes every variable.
- **Queue connection:** `PgBossService` uses `JOBS_DATABASE_URL` (`venueos_jobs`). It never creates or migrates
  the `pgboss` schema; that is a migration (docs/08). `schedule` is off until a task needs scheduled jobs.
- **Logging:** pino, `LOGGER` token. Log recipients only masked (`maskEmail`), never subjects, bodies or
  variables; the field names in `REDACT_PATHS` are blanked as a safety net.
- **Tests** (`src/__tests__`, `*.spec.ts` unit, `*.int-spec.ts` integration): need the docker Postgres (like
  `test:constraints`) and Mailpit (`docker compose up -d postgres mailpit`). `helpers/harness.ts` boots the real
  `WorkerModule` against a throwaway migrated database (`test/global-setup.mjs`) and enqueues the way the API
  does. Use `startWorker({ provider })` with a scripted provider for failure paths; run one worker at a time
  per scenario so a scripted provider is the only one that can take a job.
