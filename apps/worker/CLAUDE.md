# apps/worker — job rules

- A job extends `TenantJob` (works inside one tenant) or `SystemJob` (platform work with no tenant: `auth.purge`,
  scanners, the dead-letter check). Files are `<module folder>/<name>.job.ts`.
- A `TenantJob` payload always carries `tenantId`; its body runs inside `TenantDb.tx()` for that tenant
  as the `venueos_app` role. A `SystemJob` payload is strict (`{}` for scheduled ones) and the job uses only the
  connection it was built for.
- Scanners (finding due work across tenants) use the `venueos_jobs` connection (SELECT only on
  tenants, venues, bookings, booking_sessions, payment_schedule_items, leads, inventory_items),
  read IDs only, and enqueue one job per item. Need another table? Add it to the grants in a
  migration with a reason; never widen the role casually.
- Message delivery is an append-only event log (`message_logs`): write a new row per event with
  the same `message_key`, never update.
- The `auth.purge` job is the only worker code that uses `AuthDb` (`AuthPurgeModule` does not export it).
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

## Completion (P0-6b)

- **System jobs and schedules.** `SystemJob` (`src/jobs/system-job.ts`) is the base of tenant-less jobs. A job with a
  `schedule = { cron, tz }` is registered with pg-boss at start by `ScheduleRegistrar` (`boss.schedule`, idempotent,
  missed runs skipped); `SCHEDULER_ENABLED=false` turns that off for a worker. Every job is listed in `BASE_JOBS`
  (`jobs.module.ts`); its queue AND its `<queue>.dead` queue come from a migration.
- **Always send a singleton key.** Queues use the `short` policy: one queued job per key, and ONE when there is no
  key, so a second keyless job is silently dropped. `JobQueue.send(tx, name, payload, { singletonKey })` and
  `ctx.enqueue(target, payload, singletonKey)` make it a required parameter; never call `boss.send` directly in
  application code.
- **Job output** may be returned from `handle()` (`JobOutput`: fixed codes, keys, numbers; it lands in `pgboss.job`,
  which has no RLS). The failure code of a dead letter is on the failed job, not on its `<queue>.dead` copy.
- **Scanners** (`src/scanners`): extend `Scanner`, give it `queue`, `schedule` and `scan(ctx)`, add it to
  `BASE_JOBS`. `ctx.pages(sql, values)` walks identifiers (`id`, optional `tenant_id`; anything else is refused) and
  `ctx.enqueue(target, payload, singletonKey)` sends one strict, validated, identifier-only job per item.
  `ScannerDb` is the only `venueos_jobs` read connection; new tables need a migration with a reason, never a casual
  grant.
- **`auth.purge`** (`src/auth`): retention numbers live in `AUTH_RETENTION` and docs/02. For abandoned unverified signups
  it deletes credentials and tokens only; `users`, the tenant and audit rows stay (no runtime role may delete them).
- **`pdf.render`** (`src/pdf`): `PdfKindHandler { kind, template, load(tx), saveKey?(tx, payload, key) }` per document,
  registered in `PdfModule` (`PDF_KIND_HANDLERS`). The job loads (short tx), renders in `ChromiumPdfRenderer`
  (JavaScript off, all network aborted, one shared browser, `PDF_CONCURRENCY`), uploads through `ObjectStorage`
  (`S3ObjectStorage`; key `tenants/{tenantId}/pdf/{kind}/{entityId}.pdf`) and calls `saveKey` in a second short tx.
  Templates and fonts live in `packages/templates` (`renderPdfHtml`, `fonts/`). Never store or log a URL or the
  document's contents; the DB keeps the key.
- **Dead letters:** `ops.dead-letter-check` logs `dead letters present`; `packages/db/scripts/dead-letters.mjs` lists,
  shows, redrives and discards (docs/08 runbook).
- **Tests** also need the local S3 (SeaweedFS: `docker compose up -d s3`) and Chromium
  (`pnpm --filter @venueos/worker exec playwright install chromium`). `startWorker({ renderer, storage, kinds,
  extraJobs })` swaps in scripted parts; `pnpm --filter @venueos/worker pdf:sample` renders the English sample.

## Leads (module 5)

- `src/leads`: `LeadsFollowUpScanner` (`leads.follow-up`, every 15 min, ids only) and `LeadFollowUpNotifyJob`
  (`leads.follow-up.notify`, payload `{ tenantId, leadId }`). The notify job re-checks the lead, stamps
  `leads.follow_up_notified_for` with a conditional UPDATE and queues the `lead.follow-up-due` email with `enqueueEmail` in the SAME
  transaction (exactly once per follow-up; the stamp does not bump the lead's `rev`). It sends through its own enqueue-only
  `JobQueue` (`LEADS_JOB_QUEUE`, role `venueos_app`). Links use `APP_ORIGIN`.
