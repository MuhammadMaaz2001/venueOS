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
| web | Vercel (root dir `apps/web`) or a container on ECS | `/api/*` rewrite to the API's internal/private URL |
| api | ECS Fargate (or one EC2 with Docker Compose for the pilot) | 2 tasks behind an ALB in production |
| worker | ECS Fargate, 1 task (same image, different command) | Includes Chromium for PDFs |
| Database | RDS PostgreSQL 16+, Multi-AZ in production | Private subnet, TLS, PITR ≥ 7 days |
| Files | S3 private bucket, SSE, versioning on | Lifecycle: delete generated PDFs after 2 years unless linked |
| Email | SES with DKIM/SPF/DMARC on `venueos.app` | Bounce/complaint webhooks → `message_logs` |
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
3. DB constraint tests when `packages/db` changed
4. `pnpm audit --prod`, gitleaks
5. Build affected images

On merge to `main`: build → deploy to staging → run migrations (`venueos_migrator`) →
smoke tests → manual approval → production (migrate, then roll out api/worker, then web).

## Migrations in production

- Run `prisma migrate deploy` as a one-off task with the migrator role before the new app
  version starts.
- Expand/contract for breaking changes; never drop or rename a column in the same release
  that stops using it.
- Long-running index builds use `CREATE INDEX CONCURRENTLY` in a separate migration.

## Environment variables (names only; values in the secret store)

| App | Variables |
| --- | --- |
| api | `DATABASE_URL` (app role), `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`, `S3_BUCKET`, `AWS_REGION`, `APP_ORIGIN`, `SENTRY_DSN` |
| worker | `DATABASE_URL` (app role), `JOBS_DATABASE_URL` (jobs role), `SES_FROM`, `S3_BUCKET`, `AWS_REGION`, `SENTRY_DSN` |
| web | `API_INTERNAL_URL`, `NEXT_PUBLIC_APP_NAME`, `SENTRY_DSN` |
| db (CI/migrations) | `MIGRATE_DATABASE_URL` (migrator role) |

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
  payment → SUSPENDED (read-only) after `[14 days]` → CANCELLED (export available, data
  deleted after 90 days).
