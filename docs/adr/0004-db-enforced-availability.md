# ADR 0004 — Double booking prevented by an exclusion constraint

- Status: Accepted · 2026-11-23

## Context
Double booking is the most damaging failure for a venue. App-level "check then insert" races
when two agents book at the same moment.

## Decision
Each session writes `space_occupancies` rows (one per physical space, buffers included). A GiST
exclusion constraint forbids overlapping active rows per space; a trigger syncs the active flag
with booking status.

## Consequences
- Correct under concurrency without locks in application code.
- Combined spaces work by writing rows for each component.
- The API maps the constraint violation to `409 SLOT_TAKEN`.
- Requires the `btree_gist` extension (available on RDS and the official Postgres image).
