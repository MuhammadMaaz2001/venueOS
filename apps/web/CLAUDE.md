# apps/web — Next.js rules

- Frontend only: no database access, no secrets, no business rules beyond display logic.
- Call the API only through `@venueos/api-client` hooks in `src/features/<module>/api.ts`
  (TanStack Query). Requests go to same-origin `/api/v1/...` and send
  `X-Requested-With: venueos` on mutations.
- Forms: react-hook-form + `zodResolver` with schemas from `@venueos/shared`.
- All text through next-intl (`messages/en.json`, `messages/ur.json`); use logical CSS
  (`ms-`, `me-`, `start`, `end`) so RTL works.
- Money/dates only via `src/lib/format.ts` (tenant currency, venue timezone).
- Mobile-first: every screen usable at 360 px; event sheet has a print stylesheet.
- No `dangerouslySetInnerHTML`. Never show prices to roles without `booking.view_prices`.
