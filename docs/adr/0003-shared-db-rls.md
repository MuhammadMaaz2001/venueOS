# ADR 0003 — Shared database with Row Level Security

- Status: Accepted · 2026-11-23 · Amended 2026-11-23 (P0-0 review)

## Context
Expected tenants: tens in year one, hundreds later, each small. Separate databases per tenant
would multiply cost and migration work.

## Decision
One PostgreSQL database and schema with `tenant_id` on every tenant-owned table, forced RLS
policies keyed on a transaction-local `app.tenant_id`, an app DB role without `BYPASSRLS`, and
a `TenantDb` client that always sets the context. `tenants` and `users` (which have no
`tenant_id`) get their own policies; critical parent/child references use composite
`(tenant_id, id)` foreign keys so a child can never point at another tenant's parent.
`SECURITY DEFINER` functions (`resolve_tenant`) are owned by a `NOLOGIN BYPASSRLS` role,
because forced RLS also applies to table owners.

## Consequences
- A missing filter in code returns no rows instead of leaking data.
- Every new table must call `enable_tenant_rls()`; a CI test enforces it.
- Cross-tenant jobs need a separate role (`venueos_jobs`, SELECT-only) used only to find work.
- Large enterprise tenants can later move to a dedicated database with the same schema.
- The migrator is also subject to forced RLS: seeds and data migrations set the tenant context.
- See ADR 0007 for the auth-table split and ADR 0008 for append-only enforcement.
