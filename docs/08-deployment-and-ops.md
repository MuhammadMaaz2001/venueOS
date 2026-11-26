# 08 — Deployment and operations

## Environments

| Env | Purpose | Data | URL pattern |
| --- | --- | --- | --- |
| local | Development | Seed + test factories | `localhost:3000/4000` (movable: `WEB_PORT`, `PORT`, README "Ports") |
| staging | QA, pilot demos | Fake data only | `app.staging.venueos.app` |
| production | Paying tenants | Real data | `app.venueos.app` |

## Target setup (AWS, MVP size)

| Component | Service | Notes |
| --- | --- | --- |
| web | Container on ECS Fargate (or the same EC2 for the pilot), **same VPC as the API** | `/api/*` rewrite to the API's internal URL. Not on Vercel in the MVP: it cannot reach a private API |
| api | ECS Fargate (or one EC2 with Docker Compose for the pilot) | 2 tasks in production, **no public listener**; only the web app reaches it. `api.venueos.app` stays reserved for the future mobile/public API |
| worker | ECS Fargate, 1 task (same image, different command) | Includes Chromium for PDFs (see "PDF rendering"). Reaches S3 through its **IAM task role** |
| Database | RDS PostgreSQL 16+, Multi-AZ in production | Private subnet, TLS, PITR ≥ 7 days |
| Files | S3 private bucket, SSE, versioning on | Lifecycle: delete generated PDFs after 2 years unless linked |
| Email | SES with DKIM/SPF/DMARC on `venueos.app` | Bounce/complaint webhooks → `message_logs` events |
| Secrets | Secrets Manager / SSM | Injected as env vars at task start |
| Monitoring | Sentry, CloudWatch logs + alarms, uptime check | Alerts to the team channel |

A single EC2 with Docker Compose (web + api + worker + managed RDS) is acceptable for the
pilot; move to ECS before onboarding paying tenants.

## Builds

- Each app has its own Dockerfile using `turbo prune <app> --docker`, multi-stage, Node 24
  slim, non-root user, `NODE_ENV=production`.
- Images tagged with the git SHA; the same image is promoted from staging to production.
- Today (local scope, P0-8): `apps/api|worker|web/Dockerfile`, run together with `docker-compose.apps.yml` (README, "Run with Docker"); CI is `.github/workflows/ci.yml`. The web image bakes `API_INTERNAL_URL=http://api:4000`, so the API service must be named `api` in every environment. Registry, deploy workflow, migrate image and the AWS runbook are later (docs/09).

## CI/CD (GitHub Actions)

On every PR:
1. `pnpm install --frozen-lockfile`
2. `turbo run lint typecheck test --filter=...[origin/main]` (only affected packages)
3. DB constraint tests when `packages/db` changed (Postgres 16 service container with
   `init-roles.sql` loaded; the test creates and drops its own database)
4. `pnpm audit --prod`, gitleaks
5. Build affected images

On merge to `main`: build → deploy to staging → run migrations (`venueos_migrator`) →
smoke tests → manual approval → production (migrate, then roll out api/worker, then web).

### Smoke checks (staging, part of P0-8)

- **Real client IP:** call a cheap non-health route through the public staging URL (ALB → web → api;
  health endpoints are not access-logged, so use a `@Public()` route or any `/api/v1/...` route that
  answers 401) with a known `X-Request-Id`, then read the API's access log line for that id and
  assert its `req.ip` is the caller's public address, **not** the web server's or the ALB's private
  address. Fail the deploy otherwise: `TRUST_PROXY` does not match the hop count (see above) and all
  users share one throttle bucket.
- `GET /health/ready` returns 200 through the path the load balancer uses.
- A forged state-changing request (no `X-Requested-With`) is answered `403 CSRF_REJECTED`.

## Database roles and migrations

- Five roles exist in every environment: `venueos_migrator` (owns the schema, not a
  superuser), `venueos_definer` (`NOLOGIN BYPASSRLS`, owns `SECURITY DEFINER` functions),
  `venueos_app`, `venueos_auth`, `venueos_jobs` (see `03-data-model.md`). Locally they come from
  `packages/db/docker/init-roles.sql`; in staging/production, infrastructure code creates them
  with the same names and attributes. **All grants, policies and default privileges are in the
  migrations**, so any database that has the roles behaves the same.
- Run `prisma migrate deploy` (`pnpm --filter @venueos/db db:deploy`) as a one-off task with the
  migrator role (`MIGRATE_DATABASE_URL`, read by `packages/db/prisma.config.ts`) before the new
  app version starts. **Staging and production use `migrate deploy` only**: it needs no shadow
  database, so the migrator there has **no `CREATEDB`** (and never `SUPERUSER`).
- `prisma migrate dev` (local only) creates and drops a shadow database, so **only the local
  `packages/db/docker/init-roles.sql` gives `venueos_migrator` `CREATEDB`**. We chose that over a
  `shadowDatabaseUrl` (a second database and a second set of credentials to keep in sync). The
  constraint tests need the same privilege to create their throwaway database; in CI the role comes
  from the same `init-roles.sql`, so CI has it too. Infrastructure code for staging/production must
  not copy that line.
- The seed (`pnpm db:seed`) runs as the migrator. It always writes the plans; the demo tenant and
  demo owner are written only when `NODE_ENV` is not `production` **and** `SEED_OWNER_EMAIL` /
  `SEED_OWNER_PASSWORD` are set (local `.env` only, never a secret store value for a real
  environment). Without them the seed refuses to create the demo owner.
- The migrator is subject to forced RLS. Seeds and data migrations that touch tenant tables set
  `app.tenant_id` (and `app.user_id`) first, or write users/credentials through `venueos_auth`
  (see `03-data-model.md`).
- Expand/contract for breaking changes; never drop or rename a column in the same release
  that stops using it.
- Long-running index builds use `CREATE INDEX CONCURRENTLY` in a separate migration.
- Platform operations until a platform admin app exists (post-MVP): tenant status/plan changes
  and the dead-letter queue are handled with reviewed ops scripts run as the migrator.

### Background jobs (pg-boss)

- The `pgboss` schema, its queues (`email.send`, `email.send.dead`) and its grants are created by the
  migration `pgboss_jobs_and_email_queue`, run by `migrate deploy` as the migrator like every other
  migration. Neither the API nor the worker creates or migrates it (`migrate: false`,
  `createSchema: false`); the worker refuses to start, and the API reports `queue: down` on
  `/health/ready`, when `pgboss.version` is not the version the installed library expects.
- **pg-boss is pinned to an exact version.** To upgrade: bump the pin, run
  `node packages/db/scripts/pgboss-sql.mjs migrate <current schema version>`, put its output in a
  NEW migration (never edit an applied one), and run the tests (`jobs.test.ts` fails when the library
  and the database disagree on the schema version). Deploy the migration before the new app version.
- The worker's pg-boss connection is `JOBS_DATABASE_URL` (`venueos_jobs`). Job handlers use
  `DATABASE_URL` (`venueos_app`) inside tenant transactions.
- **Scheduled jobs.** The worker registers the cron schedule of every job that declares one
  (`boss.schedule`, stored in `pgboss.schedule`; safe on every start and on every instance, and pg-boss
  fires each occurrence once). Missed occurrences are skipped, not replayed. Today: `auth.purge` (daily 03:00
  Asia/Karachi) and `ops.dead-letter-check` (every 5 minutes). `SCHEDULER_ENABLED=false` keeps one worker from
  registering or firing schedules (tests, one-off workers). A schedule whose job was deleted from the code is
  **not** removed automatically: remove it with `boss.unschedule(name)` or
  `DELETE FROM pgboss.schedule WHERE name = '...'` as the migrator.
- **Queue policy `short`.** A queue created with the `short` policy allows ONE queued job per singleton key, and
  one when there is no key. Every producer therefore sends a singleton key (`messageKey`, `kind:entityId`, the
  scanner's per-item key); a producer that does not will see its second job silently dropped. `JobQueue.send`
  therefore takes the key as a **required** parameter (leaving it out is a type error, an empty string throws),
  and `Scanner`'s `ctx.enqueue` requires one too. Only code that bypasses `JobQueue` (a raw `boss.send`) can still
  forget it.
- **Queues are created by migrations** (`pgboss_jobs_and_email_queue`, `worker_queues_p0_6b`): a new job needs
  its queue and its `<queue>.dead` queue in a new migration, like any schema change.

### Dead letters (runbook)

A job that exhausts its retries, or fails permanently, is copied into `<queue>.dead` and stays there for 30
days. **Any dead letter is an alarm** (below): somebody must look at it.

**How you find out.** `ops.dead-letter-check` runs every 5 minutes and logs, per non-empty dead-letter queue, an
ERROR line with the exact message `dead letters present` and `{ queue, count, oldestSeconds }`. Create a
CloudWatch metric filter on that message (`{ $.msg = "dead letters present" }`, metric value `$.count`, per
`$.queue`) and alarm on **> 0 for 1 datapoint** to the team channel (see Monitoring). The line carries no
payload and no customer data.

**What is in a dead letter.** The `<queue>.dead` copy has the job's **payload only**: identifiers (`tenantId`,
`messageKey` or `kind` + `entityId`), never customer data. The **failure code** (`UNKNOWN_KIND`,
`PROVIDER_UNAVAILABLE`, ...) is on the job that failed, in its `output`; the script below joins the two.

```bash
# all as the migrator: MIGRATE_DATABASE_URL, or `pnpm --filter @venueos/db db:dead-letters -- <args>`
node packages/db/scripts/dead-letters.mjs list [--queue pdf.render.dead]   # id, queue, age, failure code, retries
node packages/db/scripts/dead-letters.mjs show <id>                       # payload + failure + the failed job's id
node packages/db/scripts/dead-letters.mjs redrive <id>                    # dry run
node packages/db/scripts/dead-letters.mjs redrive <id> --apply            # or --queue <name> --apply
node packages/db/scripts/dead-letters.mjs discard <id> --apply
```

**Procedure.**

1. `list`, then `show <id>` for each. Find the failure code, then the **cause** by queue:
   - `email.send`: the `message_logs` rows of that `messageKey` (one `failed` row per attempt, the last has
     `is_final`; `error` holds the same codes). `PROVIDER_*` = SES/SMTP trouble or a bounced address;
     `UNKNOWN_TEMPLATE`, `INVALID_PAYLOAD` = a code or data bug (a template name, variables that do not fit, a
     sealed secret copied to another row: also a security signal).
   - `pdf.render`: the worker log lines for the failed job's id (`jobId`), codes only. `RENDER_TIMEOUT` /
     `BROWSER_UNAVAILABLE` = Chromium missing or out of memory (check the task, `/dev/shm`, memory);
     `STORAGE_UNAVAILABLE` = S3 permissions or bucket; `UNKNOWN_KIND` = a producer newer than the worker (deploy
     order); `ENTITY_NOT_FOUND` = the row is gone or belongs to another tenant; `TEMPLATE_ERROR`, `TOO_LARGE` =
     a template bug.
   - `auth.purge`, `ops.dead-letter-check`: a bug or a database problem; the job log lines for its `jobId`.
2. **Fix the cause first.** A redriven job fails the same way if nothing changed.
3. `redrive <id> --apply` re-sends the same payload to the original queue (the queue's own retry policy applies
   again, and a second failure dead-letters it again) and removes the dead copy. Use `discard <id> --apply`
   only for a job that can never succeed (the entity was deleted, the message is no longer wanted). Note the
   reason in `docs/ops-log.md`.
4. The alarm clears when the queue is empty. A dead letter nobody handles is deleted by pg-boss after 30 days
   and the evidence in `message_logs` / logs is what remains: do not wait.

Never edit `pgboss.job` by hand for this: use the script (it only touches `*.dead` rows and sends through
pg-boss, so retry settings and singleton rules stay correct).

### PDF rendering

- `pdf.render` renders HTML from `packages/templates` with Playwright's headless Chromium, in the worker, and
  stores the PDF in the private bucket under `tenants/{tenantId}/pdf/{kind}/{entityId}.pdf`. The database keeps the
  **key**; the browser gets a short-lived pre-signed URL from the API.
- **Fonts are bundled** (`packages/templates/fonts`, SIL OFL: Noto Sans; English-only MVP, an Arabic family joins with the Arabic templates) and
  embedded in each document, so output does not depend on the machine's fonts.
- **Chromium is locked down**: JavaScript off, every network request aborted, no service workers, a fresh
  context per document, 30 s timeout (`PDF_RENDER_TIMEOUT_MS`), 10 MB output limit, at most `PDF_CONCURRENCY`
  (default 2) pages at once. One shared browser per worker process, started again if it dies.
- **Worker image.** The Dockerfile (P0-8) must install Chromium and its system libraries
  (`playwright install --with-deps chromium` in the build, or an OS Chromium with `PDF_CHROMIUM_PATH`), run as the
  non-root user, and give the task enough memory for `PDF_CONCURRENCY` pages (start with 1 GB of headroom per
  page) and a writable `/tmp`. The worker logs `chromium started` on the first render.
- Smoke test of a machine or image: `pnpm --filter @venueos/worker pdf:sample` writes the English sample PDF
  (`apps/worker/.artifacts/sample.pdf`, git-ignored) with no database or S3.

### Object storage (S3)

- **Production and staging: the worker's S3 access comes from its IAM task role, never from
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.** Do not set those variables, or a key file, in any task
  definition, secret or env file of a deployed environment; the AWS SDK's default provider chain finds the task
  role. The role gets `s3:PutObject` (and `s3:AbortMultipartUpload`) on `arn:aws:s3:::<bucket>/tenants/*` and
  nothing else for now (the API's task role gets `GetObject` for pre-signed URLs). The bucket is private, with
  default encryption (SSE-S3 or KMS), versioning on, and a lifecycle rule (generated PDFs 2 years unless linked).
  The worker sends the SSE header itself (`S3_SSE=AES256` by default).
- **Local development and CI: SeaweedFS** (`docker compose up -d s3`): Apache-2.0, image `chrislusf/seaweedfs`
  from Docker Hub, **pinned by public tag and digest** in `docker-compose.yml` (so `docker pull` works on any
  machine and in CI), run as `server -s3` (master, volume, filer and S3 gateway in one container). S3 API on
  `:9100`, filer web UI on `:9101` (browse buckets and objects). The access key is in
  `docker/seaweedfs/s3.json` (`venueos` / `venueos-local-secret`, local placeholders). In `apps/worker/.env`:
  `S3_ENDPOINT=http://localhost:9100`, `S3_FORCE_PATH_STYLE=true`, `S3_SSE=none` (no KMS locally) and
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` equal to that key. **Those two variables are for the local store
  only.** Create the dev bucket once (`aws --endpoint-url http://localhost:9100 s3 mb s3://venueos-local`); the
  tests create their own.
- **Upgrading the local store:** pick a release tag on Docker Hub, copy its digest into `docker-compose.yml`
  (`image: chrislusf/seaweedfs:<tag>@sha256:<digest>`), run `pnpm --filter @venueos/worker test`. The worker only
  speaks the S3 API (`ObjectStorage` / `S3ObjectStorage`), so replacing the store again changes only
  `docker-compose.yml` and these variables. (MinIO was used first and dropped: it no longer publishes pullable
  release images. Adobe S3Mock is the fallback if SeaweedFS ever has to go.)

- Staging/production use `EMAIL_PROVIDER=ses` with the task role's credentials (never keys in env
  files). CI needs a Mailpit service container for the worker's delivery tests (P0-8).

## Environment variables (names only; values in the secret store)

| App | Variables |
| --- | --- |
| api | `DATABASE_URL` (app role), `AUTH_DATABASE_URL` (auth role), `FIELD_ENCRYPTION_KEYS` (JSON keyring: active key id + keys), `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` (local store only; the API only SIGNS download links for quotation PDFs, it never writes objects), `AWS_REGION`, `APP_ORIGIN` (the web app's origin, used for the CSRF `Origin` check), `SENTRY_DSN`, `TRUST_PROXY`, `LOG_LEVEL`, `SWAGGER_ENABLED`, `THROTTLE_LIMIT`, `THROTTLE_TTL_MS`, `PORT`, `NODE_ENV` |
| worker | `DATABASE_URL` (app role), `AUTH_DATABASE_URL` (auth role, **required**, for the purge job), `JOBS_DATABASE_URL` (jobs role), `FIELD_ENCRYPTION_KEYS`, `EMAIL_PROVIDER` (`smtp` or `ses`), `SMTP_URL` (dev/Mailpit; required for `smtp`), `EMAIL_FROM_ADDRESS`, `AWS_REGION` (required for `ses`), `APP_ORIGIN` (the web app's origin, for links in internal emails; **required in production**), `S3_BUCKET` (**required**), `S3_REGION`, `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` (local store only), `S3_SSE` (`AES256` default, `aws:kms`, or `none` for the local store), `PDF_CONCURRENCY`, `PDF_RENDER_TIMEOUT_MS`, `PDF_CHROMIUM_PATH` (image with an OS Chromium), `SCHEDULER_ENABLED`, `SENTRY_DSN`, `LOG_LEVEL`, `JOB_POLLING_INTERVAL_SECONDS`, `JOB_CONCURRENCY`. Never `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` outside the local store |
| web | `API_INTERNAL_URL`, `NEXT_PUBLIC_APP_NAME`, `SENTRY_DSN` |
| db (CI/migrations) | `MIGRATE_DATABASE_URL` (migrator role); local seed only: `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` (never set in staging/production); tests only: `VENUEOS_TEST_ADMIN_URL` (superuser, used to create a throwaway database) |

`AUTH_DATABASE_URL` (role `venueos_auth`) is read by the API's `AuthModule` through `AuthDb` and by the
worker's `auth.purge` job; no other code path may use it. `DATABASE_URL` feeds `TenantDb`
(`venueos_app`).

There is no `SESSION_SECRET`: sessions are random tokens stored hashed in the database.

The API validates its environment with Zod at startup (`apps/api/src/config`) and **refuses to boot**
(exit code 1, variable names and reasons only, never values) when a required variable is missing or
malformed. Required: `DATABASE_URL`, `AUTH_DATABASE_URL`, `APP_ORIGIN` and `FIELD_ENCRYPTION_KEYS` (the worker
needs the same keyring and refuses to boot without it).

`FIELD_ENCRYPTION_KEYS` is `{"active":"k1","keys":{"k1":"<base64 of 32 random bytes>"}}`. Generate a key with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Rotation:** add a new key id to
`keys` in the API AND the worker, deploy, then make it `active`; keep the old key until no stored value still
names it (sealed email secrets are short-lived, so a few days). A key that is not 32 bytes stops the process at boot.

### `TRUST_PROXY` must equal the real number of proxies

The API takes the client address (`req.ip`) from `X-Forwarded-For`. `TRUST_PROXY` is the Express
`trust proxy` hop count: how many connections, counted from the API's own TCP peer outwards, belong
to proxies we run and may believe. `req.ip` is the first address beyond them. Count **how many
proxies actually add an entry**, not how many boxes are in the path. Set it per environment:

| Environment | Path of a request | `TRUST_PROXY` |
| --- | --- | --- |
| local dev | browser → Next.js dev `/api` rewrite → API | `0` (checked in P0-3: the dev rewrite adds no `X-Forwarded-For` of its own and passes a client-sent one through unchanged; locally every request is `::1` anyway) |
| staging / production | browser → ALB → web (Next.js rewrite) → API | `1` (see below) |

Why `1`, not `2`, behind the ALB: Next.js (16.4) does **not** append its own address to
`X-Forwarded-For`; it keeps the header it received and only fills it from the socket when the header
is absent. So the API's TCP peer is the web server, and the single `X-Forwarded-For` entry is the
client address recorded by the ALB. Trusting one hop (the web server) therefore yields the real
client. Setting `2` would also trust that ALB-recorded entry as a proxy and return whatever a caller
forged to its left. This is a property of Next.js and of the infrastructure in front of it, so it
must be re-verified with the staging smoke check below whenever Next.js, the ALB or the path changes.

The web service must only accept traffic from the ALB (security group rule: source = the ALB's
security group, no public IP); otherwise clients can reach it directly and forge `X-Forwarded-For`.

Get it wrong and per-IP features break silently:

- **Too low** (for example `0` behind the proxies): `req.ip` is the web server's address for
  *every* user, so **all users share one throttle bucket** (300 requests per minute for all of
  them together), and every access log line shows the web server's IP. This looks like random 429s
  under load.
- **Too high**: the API trusts a value the client can forge, so a caller can pick their own IP and
  dodge the throttle (and spoof the IP in logs).

Whenever a hop is added or removed (CDN, WAF, a second load balancer), update `TRUST_PROXY` in the
same change. It is verified on every staging deploy, see "Smoke checks" below.

## Backups and recovery

- RDS automated backups + PITR (≥ 7 days production), daily snapshot kept 30 days.
- Monthly restore drill to a scratch instance; record time taken in `docs/ops-log.md`.
- Targets: RPO ≤ 15 minutes, RTO ≤ 4 hours.

## Monitoring and alerts

| Alert | Threshold |
| --- | --- |
| API 5xx rate | > 1% for 5 min |
| API p95 latency | > 1.5 s for 10 min |
| Job failures / dead letters | Any dead letter: alarm on the `dead letters present` log line of `ops.dead-letter-check` (metric filter on `$.msg`, value `$.count`); see "Dead letters (runbook)" |
| Email bounce rate | > 5% daily |
| DB CPU / storage | > 80% |
| Certificate expiry | < 14 days |

## Tenant lifecycle

- Signup → TRIAL `[14 days]` → ACTIVE on payment → PAST_DUE (read-write, banner) after a missed
  payment → SUSPENDED (**read-only**: reads allowed, writes `403 TENANT_SUSPENDED`) after
  `[14 days]` → CANCELLED (export available on request).
- **Post-MVP:** a tenant offboarding **purge function run as `venueos_migrator` after the 90-day
  retention** of a cancelled tenant (the app role cannot delete bookings or ledgers). No
  implementation now; until it exists, cancelled tenants' data is kept.
