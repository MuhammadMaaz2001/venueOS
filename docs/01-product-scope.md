# 01 — Product scope

## Who it is for

Marriage halls, banquet halls, marquees, lawns, farmhouses, hotel banquet departments and
event spaces. Single venues and multi-branch groups.

## Problems the MVP must solve

- Double bookings caused by paper registers and Excel
- Inquiries on phone/WhatsApp that are never followed up
- Token, advance and balance payments tracked by hand; disputes
- Kitchen, decor and vendors getting guest counts and menus late or verbally
- No view of event profit, stock losses or which sales agent converts

## MVP (Phase 1) — 14 modules

Build order matters: each module depends on the ones above it.

| # | Module | Includes |
| --- | --- | --- |
| 1 | Setup and onboarding | Tenant signup, setup wizard, venues/branches (with opening hours), spaces (halls/lawns) with capacity, combined spaces (Hall A+B), slot templates (Lunch/Dinner, hourly, full day), currency, tax, timezone, language, receipt settings |
| 2 | Staff, roles and audit | Users, invitations, roles and permissions, discount limits per role, audit log viewer. **Built:** staff + invitations, roles page (copy, edit, retire/restore), audit log page with filters and a before/after detail |
| 3 | Catalogue and pricing | Menu items, per-head packages with minimum guests, add-ons (fixed / per head / per hour / per unit), price rules (weekday, season, specific dates), tax rates, cancellation policies, custom fields. **Built:** the catalogue page (menu items, packages with a dish picker, add-ons), the pricing page (price rules with a rent preview, tax rates, cancellation policies with a tier editor, custom field definitions) and an optional "first package" step in the setup wizard |
| 4 | Customers | Profile, preferred language, history, duplicate warning by phone (not a hard block), custom fields (sensitive ones encrypted and masked) |
| 5 | Leads / inquiries | Capture (phone, walk-in, WhatsApp, web form), stages New → Contacted → Site visit → Quoted → Negotiation → Won/Lost, assignment, follow-up reminders |
| 6 | Availability calendar | Space × date × slot grid, month/week views, free/held/confirmed colours, quick hold |
| 7 | Quotations | Server-side price calculation, PDF, email to customer, "share on WhatsApp" link (wa.me, no API), versions |
| 8 | Bookings | Multi-session bookings (Mehndi, Barat, Walima), tentative holds with expiry, confirm, change, cancel, frozen prices |
| 9 | Payments and receipts | Payment schedule (token → advance → balance), cash/bank/cheque/wallet/card entry (cheques pending → cleared/bounced), receipt PDF (English), refund requests with approval, reversals |
| 10 | Event sheet | Printable and mobile run sheet per session: date, slot, space, guest count, menu, setup and kitchen notes, assigned vendors, issued inventory; updates live when the booking changes |
| 11 | Vendors | Vendor directory, assign vendors to sessions, agreed cost, commission due and received |
| 12 | Expenses and inventory | Event and overhead expenses, event profit, inventory items, issue/return/damage ledger per event, stock on hand, low-stock alert |
| 13 | Email notifications | Quotation sent, booking confirmed, payment due, payment received, event reminder; internal alerts (new lead, follow-up due, hold expiring); editable templates per tenant |
| 14 | Dashboard and reports | Occupancy, revenue, receivables, upcoming events, event profit, expenses by category, conversion by agent |

## Roles (default, editable per tenant)

| Role | Scope | Typical permissions |
| --- | --- | --- |
| Owner | Tenant | Everything, including billing, roles, settings |
| Branch manager | Assigned venues | Bookings, pricing, discounts up to limit, vendors, expenses, reports |
| Sales agent | Assigned venues | Leads, customers, quotations, holds; confirm needs advance received |
| Accountant | Tenant | Payments, refunds (approve), expenses, financial reports |
| Operations / kitchen | Assigned venues | Read event sheets; record inventory issue/return/damage |

**Default permission sets** (seeded per tenant as system roles; the single source is `DEFAULT_ROLES` in
`packages/shared/src/roles.ts`, which a test keeps in line with this table). Permission names are in
`04-security.md` section 2. `maxDiscountPct` is the role's discount limit (absent = 0, see `05-business-rules.md`).

| Role | `maxDiscountPct` | Permissions |
| --- | --- | --- |
| Owner | 100 | All of them. Always keeps `role.manage` and `staff.manage` |
| Branch manager | 15 | `venue.view`, `venue.manage`, `catalogue.view`, `catalogue.manage`, `pricing.view`, `pricing.manage`; `customer.view`, `customer.manage`, `lead.view`, `lead.manage`; `quotation.manage`, `quotation.send`, `booking.view`, `booking.view_prices`, `booking.create`, `booking.edit`, `booking.hold`, `booking.extend_hold`, `booking.confirm`, `booking.cancel`, `booking.edit_locked`; `payment.view`, `payment.record`, `payment.refund.request`; `eventsheet.view`, `vendor.view`, `vendor.manage`, `expense.view`, `expense.record`, `inventory.view`, `inventory.record`, `inventory.adjust`; `report.view`, `report.financial` |
| Sales agent | 5 | `venue.view`, `catalogue.view`, `pricing.view`; `customer.view`, `customer.manage`, `lead.view`, `lead.manage`; `quotation.manage`, `quotation.send`, `booking.view`, `booking.view_prices`, `booking.create`, `booking.edit`, `booking.hold`, `booking.extend_hold`, `booking.confirm`; `payment.view`; `eventsheet.view`, `vendor.view`. Not included: payment.record (tenants can add it) |
| Accountant | 0 | `venue.view`, `catalogue.view`, `pricing.view`; `customer.view`, `booking.view`, `booking.view_prices`; `payment.view`, `payment.record`, `payment.reverse`, `payment.refund.request`, `payment.refund.approve`; `expense.view`, `expense.record`, `expense.reverse`, `vendor.view`; `report.view`, `report.financial` |
| Operations | 0 | `venue.view`, `catalogue.view`; `booking.view`; `eventsheet.view`, `vendor.view`, `inventory.view`, `inventory.record` |

**Managing roles (module 2).** A role is created by copying another and then edited (permissions grouped by area, discount
limit, name for custom roles). A role that holds `<area>.manage` must also hold `<area>.view` where that permission exists
(`venue.manage` needs `venue.view`; `catalogue`, `pricing`, `customer`, `lead` and `vendor` likewise), else the edit is `400 VALIDATION_ERROR`
naming the missing permission; the role editor ticks the view permission for you. A custom role nobody uses any more is
**retired**, not deleted: it cannot be edited, copied or given to anyone until it is restored, retiring a role with active
members is `422`, and system roles cannot be retired. Retired roles are hidden in the list unless asked for.
The **audit log** (`audit.view`) shows who changed what and when, newest first, filterable by what, action, person and date.
A person limited to some venues sees only the entries of those venues; entries about the workspace itself (settings, roles,
staff, event types) need access to all venues.

Owner-only by default: everything under Tenant (`tenant.settings.manage`, `billing.manage`, `staff.manage`,
`role.manage`, `audit.view`, `template.manage`), plus `customer.view_sensitive`, `booking.confirm_override`
and `booking.override_rules`. Tenants copy and edit these roles; the names of system roles stay locked.

Platform admin (tenants, plans, support access) is **post-MVP**, see below. Until then the
platform operator manages tenants, plans and status through seed/ops scripts run as the
migrator role.

## Planned markets

Pakistan first, then the Gulf. Money therefore supports 0-, 2- and 3-decimal currencies
(`Decimal(18,3)` + an ISO 4217 minor-unit map); the MVP is English-only; RTL/Arabic (Gulf) is planned later via next-intl (the i18n scaffolding stays, so
adding Arabic needs a messages file and a font).

## Explicitly out of scope for MVP

- Platform admin app (`admin.venueos.app`), TOTP 2FA for platform admins and tenant
  impersonation / support access (`users.is_platform_admin` and `actor_type = PLATFORM_ADMIN`
  are reserved; no tables yet)
- Tenant offboarding purge: a purge function run as `venueos_migrator` after the 90-day
  retention of a cancelled tenant (no implementation in the MVP; until it exists the data of
  cancelled tenants is simply kept and export is done on request)
- Customer portal and public booking widget
- Online payment gateways (payments are recorded manually)
- WhatsApp Business API and SMS (email only; a manual wa.me share link is allowed)
- Multi-branch consolidated reports beyond simple filters
- Marketplace / public venue directory
- Any AI feature
- Mobile app (the web app must be fully usable on a phone)

Keep the data model ready for these, but do not build them.

## SaaS plans (structure; prices set after pilot)

| Plan | Venues | Spaces | Users | Notable |
| --- | --- | --- | --- | --- |
| Starter | 1 | 3 | 5 | All MVP modules |
| Growth | 2 | 10 | 15 | Higher email quota |
| Enterprise | Unlimited | Unlimited | Unlimited | Custom domain, priority support |

Limits live in `plans.entitlements` (JSON) and are enforced by the API's entitlements guard.

## Definition of done for the MVP

- One pilot hall runs a full week of real operations without its paper register
- No double booking possible (constraint tests green in CI)
- Tenant isolation tests green in CI
- Every money movement has a receipt or expense record and an audit entry
- Works on a mid-range Android phone over a 4G connection
