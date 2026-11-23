# 08 — Deployment and operations

## Environments

| Env | Purpose | Data | URL pattern |
| --- | --- | --- | --- |
| local | Development | Seed + test factories | `localhost:3000/4000` |
| staging | QA, pilot demos | Fake data only | `app.staging.venueos.app` |
| production | Paying tenants | Real data | `app.venueos.app` |

## Target setup (AWS, MVP size)

| Component | Service | Notes |
| --- | --- | --- |
| web | Container on ECS Fargate (or the same EC2 for the pilot), **same VPC as the API** | `/api/*` rewrite to the API's internal URL. Not on Vercel in the MVP: it cannot reach a private API |
| api | ECS Fargate (or one EC2 with Docker Compose for the pilot) | 2 tasks in production, **no public listener**; only the web app reaches it. `api.venueos.app` stays reserved for the future mobile/public API |
| worker | ECS Fargate, 1 task (same image, different command) | Includes Chromium for PDFs |
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

## Environment variables (names only; values in the secret store)

| App | Variables |
| --- | --- |
| api | `DATABASE_URL` (app role), `AUTH_DATABASE_URL` (auth role), `FIELD_ENCRYPTION_KEYS` (JSON keyring: active key id + keys), `S3_BUCKET`, `AWS_REGION`, `APP_ORIGIN` (the web app's origin, used for the CSRF `Origin` check), `SENTRY_DSN`, `TRUST_PROXY`, `LOG_LEVEL`, `SWAGGER_ENABLED`, `THROTTLE_LIMIT`, `THROTTLE_TTL_MS`, `PORT`, `NODE_ENV` |
| worker | `DATABASE_URL` (app role), `AUTH_DATABASE_URL` (auth role, for the purge job), `JOBS_DATABASE_URL` (jobs role), `EMAIL_PROVIDER` (`smtp` or `ses`), `SMTP_URL` (dev/Mailpit), `SES_FROM`, `S3_BUCKET`, `AWS_REGION`, `SENTRY_DSN` |
| web | `API_INTERNAL_URL`, `NEXT_PUBLIC_APP_NAME`, `SENTRY_DSN` |
| db (CI/migrations) | `MIGRATE_DATABASE_URL` (migrator role); local seed only: `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` (never set in staging/production); tests only: `VENUEOS_TEST_ADMIN_URL` (superuser, used to create a throwaway database) |

`AUTH_DATABASE_URL` (role `venueos_auth`) is read by the API's `AuthModule` through `AuthDb` and by the
worker's `auth.purge` job; no other code path may use it. `DATABASE_URL` feeds `TenantDb`
(`venueos_app`).

There is no `SESSION_SECRET`: sessions are random tokens stored hashed in the database.

The API validates its environment with Zod at startup (`apps/api/src/config`) and **refuses to boot**
(exit code 1, variable names and reasons only, never values) when a required variable is missing or
malformed. Required today: `DATABASE_URL`, `APP_ORIGIN`. `AUTH_DATABASE_URL` and
`FIELD_ENCRYPTION_KEYS` are validated when present and become required with the modules that use them.

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
| Job failures / dead letters | Any dead letter |
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
