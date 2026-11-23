# ADR 0007 — Auth tables behind their own database role

- Status: Accepted · 2026-11-23

## Context
Sessions, password hashes, one-time tokens, invitations and login attempts are the most
sensitive rows we hold, and they are not tenant-owned, so tenant RLS does not protect them. A
bug in any feature module running as the app role could otherwise select password hashes or
session token hashes.

## Decision
- Password hash, failed-login counter and lock time move out of `users` into `user_credentials`.
- `user_credentials`, `auth_sessions`, `auth_tokens`, `invitations` and `login_attempts` are
  readable and writable only by a dedicated role, `venueos_auth`, used by `AuthModule`
  through `AuthDb`. `venueos_app` has no privileges on them.
- `users` stays readable by the app role under RLS: your own row, or users who have a
  membership in the current tenant. `venueos_auth` has explicit policies on `users` and
  `invitations` because login and invitation acceptance run before any tenant context exists.
- Staff invitations are their own table (tenant, email, role, venue ids, token hash), not a
  purpose of `auth_tokens`. Login throttling is stored in `login_attempts`
  (email hash, ip) so it also covers unknown emails and works across API instances.

## Consequences
- Two database connections in the API (`DATABASE_URL`, `AUTH_DATABASE_URL`).
- Signup and invitation acceptance span two roles, so they are two steps rather than one
  transaction (patterns documented in `09-phase-0-plan.md`).
- Platform admin, TOTP and impersonation are post-MVP; no tables for them now.
