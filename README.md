# venueOS

Multi-tenant SaaS that runs the whole booking business of an event venue: inquiries,
quotations, bookings, availability, payments, event sheets, vendors, expenses and inventory.
Built first for marriage halls and banquets in Pakistan, designed for any venue, country,
currency and language.

> Status: Phase 0 (foundations) is done (P0-0 to P0-8, local scope); the next work is module 1 (setup and onboarding). The AWS deploy comes later. See `docs/09-phase-0-plan.md`.

## Repository layout

```
venueOS/
├── CLAUDE.md                 # rules for Claude Code (read first)
├── apps/
│   ├── web/                  # Next.js — staff dashboard (later: customer portal, public pages)
│   ├── api/                  # NestJS — REST API /v1, auth, business logic
│   └── worker/               # NestJS standalone — pg-boss jobs (holds, reminders, emails, PDFs)
├── packages/
│   ├── db/                   # Prisma 7 schema, migrations, RLS/constraint SQL, TenantDb, AuthDb
│   ├── shared/               # Zod schemas, enums, permissions, money/date helpers
│   ├── api-client/           # generated typed API client (do not edit by hand)
│   └── templates/            # email + PDF HTML templates
├── docs/                     # product, design, security, rules, conventions, ADRs
├── turbo.json
└── pnpm-workspace.yaml
```

## Prerequisites

- Node 24 LTS (**24.7.0 or newer**: `crypto.argon2Sync`), pnpm 12.21.0 (`corepack enable pnpm` uses the pinned `packageManager`)
- Docker Desktop (local PostgreSQL 16, Mailpit and the DB constraint tests). A non-Docker
  Postgres must have the same roles as `packages/db/docker/init-roles.sql`

## Getting started

```bash
git clone <repo-url> venueOS && cd venueOS
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
cp packages/db/.env.example packages/db/.env
cp .env.example .env                     # docker compose, the web dev server and Playwright; set POSTGRES_PORT if 5432 is taken, WEB_PORT if 3000 is
# Optional: opt out of Turborepo telemetry. Turbo ignores .env files, so export it in your shell
# ($env:TURBO_TELEMETRY_DISABLED = "1" in PowerShell) or run `pnpm exec turbo telemetry disable` once.
docker compose up -d postgres mailpit s3   # Postgres :5432 (roles created on first start), local email inbox :8025, S3 (SeaweedFS) :9100
pnpm db:migrate && pnpm db:seed          # run as venueos_migrator (MIGRATE_DATABASE_URL)
pnpm dev
```

The first start of the Postgres container runs `packages/db/docker/init-roles.sql`, which
creates the five roles (`venueos_migrator`, `venueos_definer`, `venueos_app`, `venueos_auth`,
`venueos_jobs`). If you change that file, recreate the volume: `docker compose down -v`.

- Web: http://localhost:3000 (seeded owner login: see `packages/db/seed.ts`, created in task P0-2)
- API: http://localhost:4000/v1, OpenAPI docs at http://localhost:4000/docs
- Emails in development land in Mailpit: http://localhost:8025

**Ports.** The defaults are web 3000 and api 4000 (what CI uses). If another project owns them, move venueOS and keep five
settings in step (all `.env` files are gitignored; the `.env.example` files say the same):

| Setting | File | Example for web 3100 / api 4100 |
| --- | --- | --- |
| `WEB_PORT` | root `.env` (also moves the Docker web container) | `WEB_PORT=3100` |
| `PORT` | `apps/api/.env` | `PORT=4100` |
| `API_INTERNAL_URL` | `apps/web/.env` (where the web server forwards `/api/*`) | `API_INTERNAL_URL=http://localhost:4100` |
| `APP_ORIGIN` | `apps/api/.env` (CSRF `Origin` check) and `apps/worker/.env` (links in emails) | `APP_ORIGIN=http://localhost:3100` |

Playwright reads the same files (`E2E_BASE_URL` / `E2E_API_URL` override them), and it refuses to test an address that
does not answer like venueOS (`/api/health/ready`), so it never runs against another project by mistake.

## Run with Docker

The three application images (api, worker with Chromium, web) run against the same local postgres, mailpit and s3:

```bash
pnpm --filter @venueos/db db:deploy        # once: migrate the database (the images do not migrate)
docker compose -f docker-compose.yml -f docker-compose.apps.yml up --build -d --wait
curl http://localhost:3000/api/health/ready    # {"status":"ok","checks":{"database":"up","queue":"up"}}
# open http://localhost:3000/login (emails: http://localhost:8025)
docker compose -f docker-compose.yml -f docker-compose.apps.yml down
```

Stop `pnpm dev` first (both use the web port, :3000 by default; set `WEB_PORT` to move the container). The API is not published: only the web
container reaches it, as in staging. `docker-compose.apps.yml` holds local placeholders only. CI is
`.github/workflows/ci.yml`.

## Documentation

| Doc | What it covers |
| --- | --- |
| [01 Product scope](docs/01-product-scope.md) | MVP modules, roles, what is out of scope |
| [02 System design](docs/02-system-design.md) | Architecture, request flow, multi-tenancy, jobs, URLs |
| [03 Data model](docs/03-data-model.md) | Tables, relationships, conventions |
| [04 Security](docs/04-security.md) | Auth, permissions, tenant isolation, data protection, checklists |
| [05 Business rules](docs/05-business-rules.md) | Booking lifecycle, pricing, payments, cancellation, inventory |
| [06 API conventions](docs/06-api-conventions.md) | REST style, errors, pagination, idempotency |
| [07 Coding standards](docs/07-coding-standards.md) | Code structure, testing, git workflow |
| [08 Deployment and operations](docs/08-deployment-and-ops.md) | Environments, CI/CD, backups, monitoring |
| [09 Phase 0 plan](docs/09-phase-0-plan.md) | First tasks and Claude Code prompts |
| [ADRs](docs/adr/) | Why the big decisions were made |
