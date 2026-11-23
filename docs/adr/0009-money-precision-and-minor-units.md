# ADR 0009 — Money stored as Decimal(18,3) with a per-currency minor-unit map

- Status: Accepted · 2026-11-23

## Context
Pakistan (PKR, 2 decimals) is the first market, but the Gulf is planned: KWD, BHD and OMR use
3 decimals, JPY-like currencies use 0. `Decimal(14,2)` cannot store fils/baisa.

## Decision
Every amount column is `Decimal(18,3)`. Code rounds each line half-up to the currency's ISO 4217
minor unit using a map in `packages/shared`; display and API money strings use the currency's
own number of decimals (`"125000.00"` PKR, `"12.500"` KWD, `"5000"` JPY). Percentages stay
`Decimal(5,2)`.

## Consequences
- One column type for all currencies; no migration when a Gulf tenant joins.
- Rounding logic must always go through the shared helper, never ad hoc.
