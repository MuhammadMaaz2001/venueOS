# 05 — Business rules

When code and this file disagree, this file wins until it is deliberately changed. Values in
`[brackets]` are tenant settings (`TenantSettings`, §15) with the default shown.

## 1. Venues, spaces and slots

- A **space** is a bookable unit (hall, lawn, room). A **combined space** (Hall A+B) is made of
  component spaces; booking it blocks every component, and booking a component blocks it.
- Combined spaces cannot contain other combined spaces, and all components belong to the same
  venue (both enforced by database triggers).
- **Slot templates** per venue:
  - `FIXED`: named shift with start/end (Lunch 12:00–16:00, Dinner 19:00–23:30). An end earlier
    than the start means it ends the next day.
  - `HOURLY`: any start/end within the venue's opening hours (`venues.opens_at` /
    `closes_at`, venue-local; no value = no restriction; a close earlier than the open means the
    next day), minimum `slot.minHours`, else `[minHours = 2]`.
  - `FULL_DAY`: the whole day as one unit. Stored as `startTime = endTime = "00:00"` (equal times mean 24 hours;
    a FIXED slot may not have equal times). The API sets it; a client never sends times for it.
  - An `HOURLY` template's start/end default to the venue's opening hours (no hours = `00:00`-`00:00`, all
    day) and must lie inside them; changing the venue's hours later does not rewrite existing templates.
  - Slot names are unique per venue among active templates (case-insensitive).
- **Plan limits** count active venues (`maxVenues`) and active spaces (`maxSpaces`); deactivating frees a seat and
  reactivating takes one (402 at the limit). A space that is a component of an active combined space cannot be
  deactivated first. A caller limited to some venues cannot add venues or change event types (tenant-wide).
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

- The **booking number** is assigned when the booking is first put on hold (DRAFT → TENTATIVE),
  not for drafts, so abandoned quotations do not consume numbers. A DRAFT has no number; the
  quotation has its own number (§13).
- Hold duration `[holdHours = 48]`; an agent may extend once by `[holdHours]`
  (`bookings.hold_extensions` counts extensions); further extensions need `booking.extend_hold`.
- Confirmation requires cleared payments ≥ `[advancePct = 50]%` of grand total, unless
  `booking.confirm_override` (reason required, audited). At confirmation the booking's
  cancellation policy tiers are **copied** into `bookings.cancellation_snapshot`.
- Dates/spaces of a CONFIRMED booking can change only if the new slot is free (same constraint)
  and the price is re-quoted as a new version the customer accepts.
- A **session** can be cancelled on its own (`booking_sessions.status = CANCELLED`, with
  `cancelled_at`); its occupancy is released. Sessions are never deleted.
- The calendar block (`space_occupancies.active`) is derived by the database from the booking
  and session status; the application never writes it.

## 3. Pricing (server-side only)

Per session, in this order:

1. **Base rent** = `space_slot_prices.rent` for the space + slot (or `spaces.baseRent`); for
   HOURLY, rent × hours.
2. **Price rules**: all active rules matching the space, slot and date. `OVERRIDE` rules: the
   highest priority wins and replaces the rent. Then `PERCENT` and `FIXED_AMOUNT` rules apply
   in priority order. Each applied rule is shown as an `ADJUSTMENT` line.
   *Rule details (module 3, `apps/api/src/pricing`, pure functions the quotation engine reuses):*
   - A rule matches when its space (null = all) and slot (null = all) fit and its date condition holds: `DAY_OF_WEEK` =
     the venue-local date's weekday is listed; `DATE_RANGE` = first and last day, both inclusive; `SPECIFIC_DATE` = that day.
   - Shapes: `DAY_OF_WEEK` has weekdays and no dates; `DATE_RANGE` has both dates (last not before first) and no weekdays;
     `SPECIFIC_DATE` has one date. `PERCENT` is -100..1000 and not 0, `FIXED_AMOUNT` is signed and not 0, `OVERRIDE` is 0 or more.
   - `OVERRIDE`: highest `priority` wins; ties go to the more specific kind (`SPECIFIC_DATE` > `DATE_RANGE` >
     `DAY_OF_WEEK`), then the rule scoped to space and slot, then the lower id. The overrides that lose are reported, not applied.
   - `PERCENT` and `FIXED_AMOUNT` apply highest priority first, ties: percent before fixed amount, then the same
     tie-breaks. Each applies to the **running** rent (percentages compound), is rounded half-up to the currency's
     minor unit on its own line, and the rent never goes below 0 (the line is cut so the lines add up).
   - An `OVERRIDE` line is the difference to the rent before it (`new rent - rent`), signed.
   - For an `HOURLY` slot the base rent is the rent per hour times the hours (rounded) and the rules act on that total.
   - Inactive rules are ignored.
3. **Package**: `perHeadRate × max(guests, package.minGuests, session.guaranteedGuests)`.
4. **Add-ons**: FIXED = price; PER_HEAD = price × billed guests; PER_HOUR = price × hours;
   PER_UNIT = price × quantity.
5. **Discount**: amount or % on the booking subtotal, limited by the role's `maxDiscountPct`.
   A role without `maxDiscountPct` (or with an invalid value) may give **no discount** (0). The limit is
   part of the role (`roles.limits`); a caller may not raise a role's limit above their own
   (`04-security.md` section 2).
6. **Tax**: tenant default tax rate(s), exclusive or inclusive as configured; computed on the
   discounted subtotal; shown as `TAX` lines.

**Line-item signs.** `booking_line_items.amount` (and `unit_price`) is signed, and a database
CHECK enforces it per kind:

| Kind | Allowed amount |
| --- | --- |
| `DISCOUNT` | ≤ 0 |
| `ADJUSTMENT` (price-rule effect) | + or − |
| `RENT`, `PACKAGE`, `ADD_ON`, `TAX` | ≥ 0 |

A booking's `subtotal`, `discountTotal`, `taxTotal` and `grandTotal` are sums over its current
line items, and the grand total is `SUM(amount)` of all lines (DISCOUNT lines are negative, so
they reduce it). With tax-inclusive rates the other lines are stored net of tax and the `TAX`
line carries the extracted tax, so `SUM(amount)` still equals the price the customer pays.

**Inclusive-tax rounding.** For each line, with `gross` the inclusive price the customer sees:

```
tax = round(gross × rate / (100 + rate))   // half-up, to the currency's minor unit
net = gross − tax
```

`net` is derived by subtraction, never rounded separately, so `net + tax` equals `gross`
exactly and the totals always equal the inclusive prices the customer saw. Quotations and
receipts show the inclusive amounts (`gross`) when the tenant uses inclusive tax, with the tax
portion shown as a line; exclusive tenants see net amounts plus tax lines as before.

Rounding: each line rounded half-up to the **currency's minor unit** (ISO 4217 map in
`packages/shared`: PKR 2, KWD/BHD/OMR 3, JPY 0). Display may drop trailing zeros for
currencies where that is customary (PKR is shown without decimals, stored with 2). Totals are
the sum of rounded lines. Amounts are stored as `Decimal(18,3)`.

Once a booking is TENTATIVE or later, its line items are frozen. Catalogue or rule changes
never alter existing bookings. Any change creates a new quote version
(`bookings.quote_version + 1`): the new `booking_line_items` replace the current set and a new
`quotations` row freezes that version (line-item snapshot, totals, `valid_until`, `sent_at`,
`accepted_at`, `pdf_key`). Earlier versions stay readable in `quotations`.

## 4. Guest count changes

- Increase: allowed while capacity allows; per-head lines re-priced at the frozen per-head rate
  of that version unless the user re-quotes at current rates.
- Decrease below `guaranteedGuests` (if set) does not reduce the bill.
- Changes inside `[guestLockDays = 3]` days of the session need `booking.edit_locked`.
- Every change updates the event sheet immediately and emails ops staff if inside
  `[guestLockDays]`.

## 5. Payments

- **Schedule** generated on hold/confirm from tenant settings: Token `[tokenAmount = 0]` (a fixed
  amount in the tenant currency), Advance `[advancePct = 50]%` on confirm, Balance due
  `[balanceDueDays = 7]` days before the first session. Staff may edit the schedule; the total
  must equal the grand total.
- **Paid or unpaid per schedule item is computed FIFO**: cleared net received payments are
  applied to the items in due-date order. There is no allocation table.
- Methods: cash, bank transfer, cheque, card, mobile wallet (and `ONLINE_GATEWAY`, reserved for
  Phase 2). **Only a cheque starts `PENDING`**; it is later set to `CLEARED` or `BOUNCED`.
  `CASH`, `BANK_TRANSFER`, `CARD`, `MOBILE_WALLET` and `ONLINE_GATEWAY` are `CLEARED` on entry and
  stay so (a database CHECK rejects `PENDING`/`BOUNCED` for any other method). Only `CLEARED`
  entries count towards the advance and the paid total; a pending or bounced cheque never does.
- A payment's **amount is always positive**; `entry_type` decides the effect:
  `RECEIPT` (+), `REFUND` (−), `REVERSAL` (negates the entry it points to via `reverses_id`).
- Each receipt gets a receipt number from `tenant_counters` (`receipt:<year>`) and a PDF.
- **Refund**: a `refund_requests` row (`requested_by`, amount, reason) is created by a user with
  `payment.refund.request` and approved or rejected by a different user with
  `payment.refund.approve`. A tenant with exactly one active member holding refund permissions
  may self-approve (`self_approved = true`, audited). Approval only decides. **Mark paid** (by a
  user with `payment.record`, naming the method) writes the `REFUND` payment (linked by
  `refund_request_id`); the request becomes `PAID` when that payment is `CLEARED` (immediately
  for cash/bank/card/wallet; a cheque refund is `PENDING` and the request stays `APPROVED` until the
  cheque is cleared). The amount of a request cannot exceed what was paid and is not already being
  refunded.
- **Reversal** (wrong entry) = a new `REVERSAL` row with `reverses_id` pointing to the original,
  reason required. The original is never edited; each entry can be reversed once.
- Payments are append-only in the database; the only update allowed is `status`/`cleared_at`
  (cheque clearing).
- Overpayment is allowed and shown as credit; it is settled by a refund.

## 6. Cancellation

- The booking's cancellation policy (**copied into `cancellation_snapshot` at confirmation**) has
  tiers by days before the first session, e.g. ≥ 60 days → 80% refund, ≥ 30 → 50%, otherwise 0%.
  Tiers are stored from the longest notice to the shortest: `minDaysBefore` strictly descending (so unique), the last
  tier is 0 days (every cancellation falls in one tier), `refundPct` 0..100 with at most 2 decimals. A workspace has at
  most one default policy; deactivating the default leaves it without one.
  Later edits to the policy never change an existing booking.
- The system computes the suggested refund from received payments; the accountant may lower or
  raise it with a reason (it becomes a refund request). Cancelling frees all occupancies
  immediately.
- Vendor assignments of a cancelled booking become CANCELLED; issued inventory must be
  returned or written off before the booking can be closed.

## 7. Event sheet

- One sheet per session: venue, space, date, slot and times, event type, customer name and
  contact person, guests (and guaranteed), package items, add-ons, setup notes, kitchen notes,
  vendors with arrival times, inventory issued, payment status (paid/balance only, no full
  ledger for ops staff). Cancelled sessions are marked cancelled.
- Ops/kitchen roles see sheets for their venues only and cannot see prices except payment
  status.
- The sheet is generated live; the printed PDF shows "version N, generated at …" where N is the
  booking's `quote_version`.

## 8. Vendors

- A vendor may be assigned to many sessions; the same vendor at overlapping times shows a
  warning (not a block, vendors can bring several teams).
- `agreedCost` = what the venue pays the vendor; payments to vendors are recorded as
  `VENDOR` expenses linked to the vendor and booking.
- `commissionAmount` = what the vendor owes the venue (default `vendor.commissionPct` × the
  add-on price billed to the customer, editable). Received commission is recorded on the
  assignment; outstanding commission appears in the vendor report.

## 9. Expenses

- Every expense has category, amount (always positive), method and date; it may link to a
  booking, a session and/or a vendor. Unlinked expenses are overheads.
- A bill photo can be attached (`receipt_key`).
- Expenses are **append-only**: there is no edit window. A mistake is fixed with a
  `REVERSAL` entry (`reverses_id`, reason, needs `expense.reverse`) followed by a new correct
  expense. Reversals net against the original in every total.

## 10. Inventory

- Ledger types: PURCHASE (+, may link to the expense that paid for it), ISSUE (−, to a
  session), RETURN (+ for the returned quantity, from a session), DAMAGE (−, **in-store damage
  only**, valued at the cost snapshot), ADJUSTMENT (±, after a stock count, reason required).
- **Damage at an event is recorded on the RETURN** as `returned_qty` and `damaged_qty`:
  damaged or lost units were already deducted at ISSUE, so the RETURN adds back only
  `returned_qty` and stock is not reduced twice.
- A session is reconciled when issued = returned_qty + damaged_qty (summed over its movements);
  otherwise the event sheet shows "stock not reconciled" and the session cannot be marked complete.
- `inventory_items.on_hand` is stored and can never go negative (CHECK). A movement locks the
  item row, inserts the ledger row and updates `on_hand` in one transaction; ISSUE/DAMAGE/negative
  ADJUSTMENT beyond what is on hand → `422 INSUFFICIENT_STOCK`.
- **Nightly reconciliation (`inventory.reconcile`)**: for every active item the job compares the
  stored `on_hand` with `SUM(stock_delta)` over its movements. Any mismatch is reported to the
  branch manager(s) of the item's venue (all branch managers of the tenant when the item is
  shared) by email, listing item, `on_hand`, ledger sum and difference, and is recorded in the
  audit log as a SYSTEM entry. The job only reports; it never corrects stock (a correction is an
  ADJUSTMENT movement by a person with `inventory.adjust`).
- Worked example: stock 100 (a PURCHASE of +100), ISSUE 10 → 90, RETURN with `returned_qty = 8`,
  `damaged_qty = 2` → 98. On hand dropped by 2, not 4, and the session is reconciled
  (10 = 8 + 2). The damage value is 2 × the movement's `unit_cost` snapshot.
- Every movement stores a `unit_cost` snapshot of the item's cost at that moment, so damage
  value and event profit do not change when the item's cost is edited later.
- Damage may be charged to the customer as an add-on line on a new booking version.

## 11. Event profit

```
Event profit = revenue (line items excluding tax)
             + vendor commission (received or due, per report setting)
             − expenses linked to the booking or its sessions (reversals net out)
             − damage value of inventory charged to the event (damaged_qty × unit_cost snapshot)
```

## 12. Leads

- A lead is created for every inquiry; duplicate customers are flagged by phone (normalized to
  E.164 using the tenant's country). The UI **warns** about a matching phone and lets the user
  pick the existing customer or continue; phone is not unique in the database (relatives may
  share a number).
- **Phones** are typed any way (`0300 1234567`, `+92 300 1234567`, `0092...`) and stored as E.164. A number without a
  country code is read with the workspace country (`packages/shared/src/phone.ts`: calling code, trunk digit and national
  length per country; a country not in the table needs the `+code`). **Duplicates** are other active customers with the same
  phone (their phone or alternative phone) or the same email (case-insensitive); the API returns them on create, on read and
  from `GET /v1/customers/duplicates`, and never refuses the save. Customers are never deleted: `active = false`.
- **A lead** has a venue, a customer (existing, or created inline in the same transaction), an event type, a preferred date
  (maybe flexible), guests, a budget, a source (`walk_in`, `phone`, `whatsapp`, `web`, `referral`, `other`), an assignee,
  the next follow-up, notes and the tenant's custom fields for leads. The assignee defaults to the person recording it.
- **Stage changes** (`checkLeadStageChange` in `packages/shared`): between open stages in any direction; from an open stage
  to WON or LOST; a LOST lead can be reopened to an open stage (new follow-up required); WON is final. `QUOTED` and `WON`
  will be set by the quotation and booking modules; until they exist staff set them by hand. LOST needs a reason. Closing a
  lead clears its follow-up, and a closed lead cannot have one.
- **Follow-ups.** `leads.follow-up` runs every 15 minutes and emails the assignee once for each follow-up time that has
  passed on an open lead (`leads.follow_up_notified_for`); a new follow-up time or a new assignee makes the lead due again.
  Workspaces that are suspended or cancelled get none. The dashboard counts overdue leads (follow-up before now) and leads
  due later today (workspace time zone). A lead assigned to somebody else sends them the "new lead assigned" email.
- **Activity log** of a lead = its audit rows (`lead.create`, `lead.stage_change`, `lead.assign`, `lead.update` with notes and
  the other fields).
- Stages: NEW → CONTACTED → SITE_VISIT → QUOTED → NEGOTIATION → WON / LOST. Creating a
  quotation moves the lead to QUOTED; confirming a booking moves it to WON. LOST needs a reason.
- `nextFollowUpAt` is required for open leads; overdue follow-ups email the assignee.

## 13. Numbering

- Booking number: `{prefix}-{year}-{seq:4}` (e.g. `RB-2026-0142`), sequence per tenant per year
  (`booking:<year>`), allocated when the booking is first held (§2).
- Quotation number: `{prefix}-Q-{year}-{seq:4}` (`quotation:<year>`), allocated when a booking's
  first quotation is created and shared by all its versions (`quotations.version` distinguishes
  them).
- Receipt number: `{prefix}-R-{year}-{seq:5}` (`receipt:<year>`).
- Numbers are never reused, including for cancelled bookings.

## 14. Emails sent in MVP

| Event | To | When |
| --- | --- | --- |
| Quotation sent | Customer | On "send quotation" (PDF attached) |
| Booking confirmed | Customer | On confirm (PDF summary) |
| Payment received | Customer | On each payment (receipt PDF) |
| Payment due | Customer | `[reminderDays = 3]` days before each unpaid schedule item |
| Event reminder | Customer | `[eventReminderDays = 2]` days before the first session |
| Event sheet | Ops staff of the venue | Day before each session, and on changes inside the lock window |
| New lead / follow-up due / hold expiring | Assigned agent | On event |
| Low stock | Branch manager | Daily digest |

Customer emails and PDFs use `customers.preferred_locale`, else the tenant's `defaultLocale`. The MVP is English-only (`en`, the fallback of every template); the columns stay so that Arabic can be added later without a migration.

## 15. Tenant settings (`tenants.settings`)

One typed Zod schema, `TenantSettings`, lives in `packages/shared`; it parses the JSON and fills
the defaults below, so code never reads raw keys or hard-codes these numbers.

| Key | Default | Meaning |
| --- | --- | --- |
| `bookingPrefix` | `"BK"` | Prefix of booking, quotation and receipt numbers |
| `holdHours` | 48 | Tentative hold duration (and one agent extension) |
| `advancePct` | 50 | Percent of grand total needed to confirm |
| `tokenAmount` | 0 | Fixed token amount in the tenant currency (0 = no token) |
| `balanceDueDays` | 7 | Days before the first session when the balance is due |
| `guestLockDays` | 3 | Days before a session after which changes need `booking.edit_locked` |
| `reminderDays` | 3 | Payment-due reminder lead time |
| `eventReminderDays` | 2 | Event reminder lead time |
| `minHours` | 2 | Default minimum hours for HOURLY slots |
| `quotationValidDays` | 14 | Days a sent quotation is valid (`validUntil`) |
| `holdWarnHours` | 6 | The agent is warned this many hours before a hold ends |

## 16. Signup and trial (P0-4)

- Signup creates the tenant in status `TRIAL` for **14 days** (`trial_ends_at`) on the `starter` plan (a
  `subscription` with status `active` until the trial ends, so the plan limits of `starter` apply from day one),
  the five default roles, and the signing user as Owner. Country, currency, time zone and default language come
  from the signup form; nothing is assumed.
- The workspace is usable after the owner confirms the email address (login is refused before that).
- Staff invitations count toward `maxUsers` while they are pending (72 h); an expired or revoked one frees the seat.

## 17. Catalogue (module 3)

- Menu items, packages, add-ons, tax rates, cancellation policies and custom field definitions are **tenant-wide** and are
  never deleted: `active = false` hides them (a booking keeps its frozen copy). Names are unique among active rows,
  case-insensitively; reactivating a name that is taken is `409`.
- A **package** is a per-head rate, a minimum number of guests (billed at least that many, step 3 above) and dishes with a
  quantity. Only active menu items can be added; a dish deactivated later stays in the package and is shown as inactive.
- An **add-on** is `FIXED`, `PER_HEAD`, `PER_HOUR` or `PER_UNIT` (step 4 above). The vendor link arrives with the vendors module.
- **Tax rates** are exclusive (added on top) or inclusive (§3, inclusive rounding) with at most one default; a workspace
  with no active rate quotes no tax. Several default rates at once are not supported in the MVP.
- **Custom field definitions** belong to `customer`, `booking`, `session` or `lead`, with a type (`text`, `number`, `date`,
  `select`, `phone`), choices for `select`, `required` and `sensitive` (text, number and phone only; encrypted and masked
  when the values are stored, docs/04 section 6). Entity, key, type and sensitivity are fixed after creation, and a key stays
  reserved for its record type even when the field is deactivated. The values are stored with the records (module 4 onwards).
- Only **customer** fields can be sensitive for now (docs/04 section 6); the other record types get it when they need it.
- Amounts use the tenant currency's decimals (`PKR` 2, `KWD` 3, `JPY` 0): a client amount with more decimals is `400`.

## 18. Modules 6-8: decisions

Where the rules above left a question open, this is what the code does.

- **Quotation = DRAFT booking.** Versions are `quotations` rows with the same number; an unsent draft is re-priced in place, anything
  sent, held or confirmed gets a new version. Prices are frozen per session and per booking (section 4); `requote: CURRENT` re-prices
  at today's catalogue.
- **Discount.** On the subtotal, a percentage or an amount; the role's `maxDiscountPct` caps it (an amount is compared as a
  percentage of the subtotal). Inclusive tax: line amounts are stored net, `tax_amount` per line, the TAX line is the sum of the
  contained taxes (never below 0) and the total is what the customer pays; the discount is split the same way.
- **Quotes warn, holds block.** A quote reports taken slots and broken local rules (`warnings`) but is never refused for them.
  A hold answers `409 SLOT_TAKEN` (from the database constraint) or `422 LOCAL_RULE` (opening hours, minimum notice, minimum or
  maximum hours...) unless the caller has `booking.override_rules` and gives a reason.
- **Buffers.** A combined space writes one occupancy row per component, each with the larger of the combined space's and the
  component's setup and cleanup buffers.
- **Hold timer.** `holdHours` from the first hold; ONE extension by anyone with `booking.hold`, a second needs `booking.extend_hold`.
  A hold ends exactly at `holdExpiresAt`: the 5-minute scanner may take up to 5 minutes to notice, so confirm and extend re-check
  the time themselves.
- **Confirm** needs cleared net receipts of at least `advancePct` of the grand total, else `422 ADVANCE_REQUIRED`, unless the caller
  has `booking.confirm_override` and a reason. The cancellation policy snapshot is refreshed at confirm (the policy in force when the
  customer committed wins). Confirming moves the lead to WON. The payment SCHEDULE (token, advance, balance rows) is generated by
  module 9, not here.
- **Changing a booking.** A DRAFT replaces its sessions as a whole (PATCH with `sessions`); a held or confirmed booking changes one
  session at a time (add, change, soft-cancel). Guest changes inside `guestLockDays` need `booking.edit_locked`; `guaranteedGuests`
  never reduce the bill; cancelling a session frees its slots and re-prices. The last active session cannot be cancelled (cancel
  the booking).
- **Cancel** frees the slots at once and computes `suggestedRefund` from the policy snapshot (days between the cancel and the first
  session, the tier that applies, times cleared receipts). Money moves in module 9. **Restore** puts the booking back in the status
  it was cancelled from and is `409 SLOT_TAKEN` when the slot was taken in the meantime; it needs `booking.cancel`. **Re-hold** of an
  EXPIRED booking needs `booking.hold` and the same slot checks.
- **Complete.** The job moves a CONFIRMED booking to COMPLETED 24 hours after its last session when the balance is paid; an unpaid
  booking stays CONFIRMED.
- **Lists.** `from` / `to` on the bookings list match when ANY active session starts in the range (workspace time zone).
- **Sending.** A quotation can be sent once its PDF is ready (`422` before that, the page polls); the email goes to the customer's
  address or the `to` the agent typed, with the PDF attached. The WhatsApp link is `wa.me` with a text summary.

## 19. Module 9: decisions

Where the rules above left a question open, this is what the code does.

- **Schedule.** Generated once, at the first hold (and at confirmation if there is none): Token (the fixed `tokenAmount`, due the day of the hold), Advance (`advancePct` of the grand total, LESS the token: the token counts towards the advance; due on the last day of the hold) and Balance (the rest, due `balanceDueDays` before the first session, never before the advance). Zero-amount items are left out; the items always add up to the grand total (the Balance takes the rounding). A re-hold keeps the schedule it has. A new quote version that changes the total generates the items again from the settings but keeps the dates the schedule already had (the reminders already sent for an unchanged item are kept). Staff with `payment.record` may replace the items while the slot is held or the booking is confirmed; they must add up to the grand total.
- **Status per item** is never stored: the CLEARED net receipts (`bookings.paid_total`) fill the items in due-date order (ties in creation order). An item is PAID, PARTLY (money reached it, not yet due or not covered), UNPAID, or OVERDUE (something is still owed and its due date, in the venue's time zone, is before today; a partly paid item past due is OVERDUE).
- **Recording.** Allowed while the slot is held, or the booking is confirmed or completed (not for a quotation, an expired or a cancelled booking). The receipt number is `{prefix}-R-{year}-{seq:5}`; the counter is per workspace and year. A cheque needs its number. A payment cannot be dated in the future. An overpayment is credit.
- **Cheques.** Clear: PENDING to CLEARED. Bounce: PENDING or CLEARED to BOUNCED (a bank can return a cheque after it cleared, which lowers the paid total and can make a confirmed booking's advance "no longer covered": the booking page says so, nothing is undone automatically). A refund cheque clears but never bounces here; a reversed entry cannot bounce.
- **Reversal.** Only a CLEARED receipt can be reversed (a pending or bounced cheque has nothing to take back; a refund is money already paid out), once, with a reason. The reversal copies the method and amount and points to the original.
- **Receipts.** The PDF is rendered when the payment is recorded (a cheque again when it clears). The customer's email goes out when the PDF of a CLEARED receipt is saved, once per payment; a pending cheque is emailed when it clears; a reversed receipt is never emailed; a customer without an address gets none. The resend action sends the existing PDF to the customer or to another address.
- **Ready to confirm.** `readyToConfirm` is true while the booking is held and the cleared receipts reach the advance. It is shown, never acted on: nobody and nothing confirms by itself.
- **Refund queue.** Anyone with `payment.view` reads it; `payment.refund.approve` decides; `payment.record` pays out. A rejection needs a reason. The suggested refund of a cancelled booking (from the policy snapshot) is shown and pre-fills the request, which may be for another amount.
- **Receivables.** Confirmed and completed bookings whose paid total is below the grand total, sorted by how long they have been overdue, then by the next due date. A held booking is not a receivable yet: its token and advance are what confirmation waits for. "Due this week" counts unpaid items due from today to six days ahead that are not overdue.
- **Reminders.** One email per schedule item, from `reminderDays` before its due date (also for an item that is already late and was never reminded), after 09:00 in the workspace's time zone, for held and confirmed bookings only. Overdue items are flagged in the API and the screens; there is no overdue email in the MVP.
- **Money never bumps a booking's `rev`**, and the booking history shows the money steps to people who hold `payment.view`.
