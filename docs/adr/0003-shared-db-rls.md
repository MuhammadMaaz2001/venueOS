# ADR 0003 — Shared database with Row Level Security

- Status: Accepted · 2026-11-23

## Context
Expected tenants: tens in year one, hundreds later, each small. Separate databases per tenant
would multiply cost and migration work.

## Decision
One PostgreSQL database and schema with `tenant_id` on every tenant-owned table, forced RLS
policies keyed on a transaction-local `app.tenant_id`, an app DB role without `BYPASSRLS`, and
a `TenantDb` client that always sets the context.

## Consequences
- A missing filter in code returns no rows instead of leaking data.
- Every new table must call `enable_tenant_rls()`; a CI test enforces it.
- Cross-tenant jobs need a separate role used only to find work.
- Large enterprise tenants can later move to a dedicated database with the same schema.
