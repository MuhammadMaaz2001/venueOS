# ADR 0002 — Separate NestJS backend instead of Next.js API routes

- Status: Accepted · 2026-11-23

## Context
The product needs background jobs from day one (hold expiry, reminders, emails, PDFs), a
future mobile app and public API, and strict, central enforcement of tenant and permission
checks on every request.

## Decision
Next.js is the frontend only. Business logic lives in a NestJS REST API (`apps/api`) and a
NestJS worker (`apps/worker`). The web app reaches the API through a same-origin `/api`
rewrite.

## Consequences
- Guards, interceptors and CLS give one place for auth, tenant, permission and plan checks.
- OpenAPI comes from the API and drives a generated client.
- About one extra week of setup compared with a Next.js-only app.
