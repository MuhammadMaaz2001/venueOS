# 05 — Business rules

When code and this file disagree, this file wins until it is deliberately changed. Values in
`[brackets]` are tenant settings with the default shown.

## 1. Venues, spaces and slots

- A **space** is a bookable unit (hall, lawn, room). A **combined space** (Hall A+B) is made of
  component spaces; booking it blocks every component, and booking a component blocks it.
- Combined spaces cannot contain other combined spaces.
- **Slot templates** per venue:
  - `FIXED`: named shift with start/end (Lunch 12:00–16:00, Dinner 19:00–23:30). An end earlier
    than the start means it ends the next day.
  - `HOURLY`: any start/end within opening hours, minimum `[minHours = 2]`.
  - `FULL_DAY`: the whole day as one unit.
- Each space has `setupBufferMin` and `cleanupBufferMin`. The occupancy range is
  `start − setup buffer` to `end + cleanup buffer`. Back-to-back sessions are allowed when
  ranges touch but do not overlap.
- **Local rules** (`venues.localRules`): e.g. `latestEndTime`, `maxGuests`. A session that
  breaks one is rejected with `422 LOCAL_RULE` unless the user has `booking.override_rules`
  (audited with reason).

## 2. Booking lifecycle

| Status | Blocks calendar | Entered by | Leaves to |
| --- | --- | --- | --- |
| `DRAFT` | No | Creating a quotation | TENTATIVE, CANCELLED |
| `TENTATIVE` | Yes, until `holdExpiresAt` | Hold (optional token) | CONFIRMED, CANCELLED, EXPIRED |
| `CONFIRMED` | Yes | Required advance received | COMPLETED, CANCELLED |
| `COMPLETED` | Yes (history) | Day after the last session, by job, if balance is paid; otherwise stays CONFIRMED and appears in receivables | — |
| `CANCELLED` | No | User action | TENTATIVE/CONFIRMED only via "restore" (fails if slot taken) |
| `EXPIRED` | No | Hold job | TENTATIVE via "re-hold" (fails if slot taken) |

- Hold duration `[holdHours = 48]`; an agent may extend once by `[holdHours]`; further
  extensions need `booking.extend_hold`.
- Confirmation requires payments ≥ `[advancePct = 50]%` of grand total, unless
  `booking.confirm_override` (reason required, audited).
- Dates/spaces of a CONFIRMED booking can change only if the new slot is free (same constraint)
  and the price is re-quoted as a new version the customer accepts.

## 3. Pricing (server-side only)

Per session, in this order:

1. **Base rent** = `space_slot_prices.rent` for the space + slot (or `spaces.baseRent`); for
   HOURLY, rent × hours.
2. **Price rules**: all active rules matching the space, slot and date. `OVERRIDE` rules: the
   highest priority wins and replaces the rent. Then `PERCENT` and `FIXED_AMOUNT` rules apply
   in priority order. Each applied rule is shown as an `ADJUSTMENT` line.
3. **Package**: `perHeadRate × max(guests, package.minGuests, session.guaranteedGuests)`.
4. **Add-ons**: FIXED = price; PER_HEAD = price × billed guests; PER_HOUR = price × hours;
   PER_UNIT = price × quantity.
5. **Discount**: amount or % on the booking subtotal, limited by the role's `maxDiscountPct`.
6. **Tax**: tenant default tax rate(s), exclusive or inclusive as configured; computed on the
   discounted subtotal; shown as `TAX` lines.

Rounding: each line rounded half-up to the currency's minor unit (PKR: 0 decimals in display,
2 stored). Totals are the sum of rounded lines.

Once a booking is TENTATIVE or later, its line items are frozen. Catalogue or rule changes
never alter existing bookings. Any change creates a new version (`bookings.version + 1`).

## 4. Guest count changes

- Increase: allowed while capacity allows; per-head lines re-priced at the frozen per-head rate
  of that version unless the user re-quotes at current rates.
- Decrease below `guaranteedGuests` (if set) does not reduce the bill.
- Changes inside `[guestLockDays = 3]` days of the session need `booking.edit_locked`.
- Every change updates the event sheet immediately and emails ops staff if inside
  `[guestLockDays]`.

## 5. Payments

- **Schedule** generated on hold/confirm from tenant settings: Token `[0]`, Advance
  `[advancePct = 50]%` on confirm, Balance due `[balanceDueDays = 7]` days before the first
  session. Staff may edit the schedule; the total must equal the grand total.
- Methods: cash, bank transfer, cheque, card, mobile wallet. Cheques may be recorded as
  pending and marked cleared later.
- Each payment gets a receipt number from `tenant_counters` (`receipt:<year>`) and a PDF.
- **Refund** = payment with `direction = REFUND`, requested by one user and approved by another
  with `payment.refund.approve`.
- **Reversal** (wrong entry) = a new row with `reversesId` pointing to the original, opposite
  sign, reason required. The original is never edited.
- Overpayment is allowed and shown as credit; it is settled by a refund.

## 6. Cancellation

- The booking's cancellation policy (copied at confirmation) has tiers by days before the
  first session, e.g. ≥ 60 days → 80% refund, ≥ 30 → 50%, otherwise 0%.
- The system computes the suggested refund from received payments; the accountant may lower or
  raise it with a reason. Cancelling frees all occupancies immediately.
- Vendor assignments of a cancelled booking become CANCELLED; issued inventory must be
  returned or written off before the booking can be closed.

## 7. Event sheet

- One sheet per session: venue, space, date, slot and times, event type, customer name and
  contact person, guests (and guaranteed), package items, add-ons, setup notes, kitchen notes,
  vendors with arrival times, inventory issued, payment status (paid/balance only, no full
  ledger for ops staff).
- Ops/kitchen roles see sheets for their venues only and cannot see prices except payment
  status.
- The sheet is generated live; the printed PDF shows "version N, generated at …".

## 8. Vendors

- A vendor may be assigned to many sessions; the same vendor at overlapping times shows a
  warning (not a block, vendors can bring several teams).
- `agreedCost` = what the venue pays the vendor; payments to vendors are recorded as
  `VENDOR` expenses linked to the vendor and booking.
- `commissionAmount` = what the vendor owes the venue (default `vendor.commissionPct` × the
  add-on price billed to the customer, editable). Received commission is recorded on the
  assignment; outstanding commission appears in the vendor report.

## 9. Expenses

- Every expense has category, amount, method and date; it may link to a booking, a session
  and/or a vendor. Unlinked expenses are overheads.
- A bill photo can be attached. Edits after `[expenseLockDays = 7]` days need
  `expense.edit_locked`; deletion is replaced by reversal.

## 10. Inventory

- Ledger types: PURCHASE (+), ISSUE (−, to a session), RETURN (+, from a session),
  DAMAGE (−, optional session, valued at `unitCost`), ADJUSTMENT (±, after a stock count, reason
  required).
- Issued − returned − damaged must be 0 for a session before it is marked complete;
  otherwise the event sheet shows "stock not reconciled".
- Stock on hand can never go negative: ISSUE more than on hand → `422 INSUFFICIENT_STOCK`.
- Damage may be charged to the customer as an add-on line on a new booking version.

## 11. Event profit

```
Event profit = revenue (line items excluding tax)
             + vendor commission (received or due, per report setting)
             − expenses linked to the booking or its sessions
             − damage value of inventory charged to the event
```

## 12. Leads

- A lead is created for every inquiry; duplicate customers are matched by phone (normalized
  to E.164 using the tenant's country).
- Stages: NEW → CONTACTED → SITE_VISIT → QUOTED → NEGOTIATION → WON / LOST. Creating a
  quotation moves the lead to QUOTED; confirming a booking moves it to WON. LOST needs a reason.
- `nextFollowUpAt` is required for open leads; overdue follow-ups email the assignee.

## 13. Numbering

- Booking number: `{prefix}-{year}-{seq:4}` (e.g. `RB-2026-0142`), sequence per tenant per year.
- Receipt number: `{prefix}-R-{year}-{seq:5}`.
- Numbers are never reused, including for cancelled bookings.

## 14. Emails sent in MVP

| Event | To | When |
| --- | --- | --- |
| Quotation sent | Customer | On "send quotation" (PDF attached) |
| Booking confirmed | Customer | On confirm (PDF summary) |
| Payment received | Customer | On each payment (receipt PDF) |
| Payment due | Customer | `[reminderDays = 3]` days before each schedule item |
| Event reminder | Customer | `[eventReminderDays = 2]` days before the first session |
| Event sheet | Ops staff of the venue | Day before each session, and on changes inside the lock window |
| New lead / follow-up due / hold expiring | Assigned agent | On event |
| Low stock | Branch manager | Daily digest |
