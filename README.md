# venueOS

Multi-tenant SaaS that runs the whole booking business of an event venue: inquiries,
quotations, bookings, availability, payments, event sheets, vendors, expenses and inventory.
Built first for marriage halls and banquets in Pakistan, designed for any venue, country,
currency and language.

> Status: Phase 0 (foundations). See `docs/09-phase-0-plan.md`.

## Repository layout

```
venueOS/
├── CLAUDE.md                 # rules for Claude Code (read first)
├── apps/
│   ├── web/                  # Next.js — staff dashboard (later: customer portal, public pages)
│   ├── api/                  # NestJS — REST API /v1, auth, business logic
│   └── worker/               # NestJS standalone — pg-boss jobs (holds, reminders, emails, PDFs)
├── packages/
│   ├── db/                   # Prisma schema, migrations, RLS/constraint SQL, TenantDb
│   ├── shared/               # Zod schemas, enums, permissions, money/date helpers
│   ├── api-client/           # generated typed API client (do not edit by hand)
│   └── templates/            # email + PDF HTML templates
├── docs/                     # product, design, security, rules, conventions, ADRs
├── turbo.json
└── pnpm-workspace.yaml
```

## Prerequisites

- Node 24 LTS, pnpm 10+
- Docker (for local PostgreSQL) or a local PostgreSQL 16+ with the `btree_gist` extension

## Getting started

```bash
git clone <repo-url> venueOS && cd venueOS
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
docker compose up -d postgres mailpit   # Postgres :5432, local email inbox :8025
pnpm db:migrate && pnpm db:seed
pnpm dev
```

- Web: http://localhost:3000 (seeded owner login: see `packages/db/seed.ts`, created in task P0-2)
- API: http://localhost:4000/v1, OpenAPI docs at http://localhost:4000/docs
- Emails in development land in Mailpit: http://localhost:8025

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
