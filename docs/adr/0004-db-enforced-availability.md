# ADR 0004 — Double booking prevented by an exclusion constraint

- Status: Accepted · 2026-11-23 · Amended 2026-11-23 (P0-0 review)

## Context
Double booking is the most damaging failure for a venue. App-level "check then insert" races
when two agents book at the same moment.

## Decision
Each session writes `space_occupancies` rows (one per physical space, buffers included). A GiST
exclusion constraint forbids overlapping active rows per space. `active` is never set by the
application: a `BEFORE INSERT` trigger derives it from the booking and session status, and
`AFTER UPDATE OF status` triggers on `bookings` and `booking_sessions` keep it in step. A
DRAFT quotation therefore never blocks the calendar, even by mistake, and a cancelled session
frees only its own slot.

## Consequences
- Correct under concurrency without locks in application code.
- Combined spaces work by writing rows for each component; the DB also forbids nested
  combined spaces and cross-venue components.
- The API maps the constraint violation to `409 SLOT_TAKEN`; moving DRAFT → TENTATIVE or
  restoring a cancelled booking/session can raise it too.
- Requires the `btree_gist` extension (trusted; available on RDS and the official Postgres image).
