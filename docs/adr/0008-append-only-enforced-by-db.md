# ADR 0008 — Append-only ledgers enforced by database privileges

- Status: Accepted · 2026-11-23

## Context
"Payments are immutable" and "never hard-delete" were application conventions only; the app
role had UPDATE and DELETE everywhere, so one bug or one compromised service could rewrite
money history.

## Decision
`venueos_app` has no UPDATE or DELETE on `expenses`, `inventory_movements`, `audit_logs` and
`message_logs`; on `payments` it has no DELETE and may update only `status` and `cleared_at`
(column-level grant, for cheque clearing). It also has no DELETE on `tenants`, `users`,
`bookings`, `booking_sessions`, `quotations` and `refund_requests`, and is read-only on `plans`.

Corrections are new rows: payments and expenses carry `entry_type` (`RECEIPT`/`REFUND`/
`REVERSAL`, `EXPENSE`/`REVERSAL`) with a positive `amount` and a unique `reverses_id`. Refunds
are `refund_requests` rows whose approval creates the `REFUND` payment. `message_logs` is an
event log: every delivery event is a new row sharing a `message_key`. Inventory stock is a
stored `on_hand` with `CHECK (on_hand >= 0)`; damage at an event is recorded on the RETURN so
stock is not deducted twice, and every movement snapshots `unit_cost`.

## Consequences
- The rules hold even if application code is wrong; tests exercise them with the real roles.
- Tenant offboarding and any legitimate purge run as the migrator in a dedicated procedure.
- New ledger-like tables must declare their privilege class in their migration
  (`make_append_only`, `revoke_delete`, `restrict_to_auth`).
