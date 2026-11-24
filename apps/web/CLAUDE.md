# apps/web — Next.js rules

- Frontend only: no database access, no secrets, no business rules beyond display logic.
- Call the API only through `@venueos/api-client` hooks in `src/features/<module>/api.ts`
  (TanStack Query). Requests go to same-origin `/api/v1/...` and send
  `X-Requested-With: venueos` on mutations. Editable forms keep the resource's `rev` and send it
  back; handle `VERSION_CONFLICT` by reloading.
- Forms: react-hook-form + `zodResolver` with schemas from `@venueos/shared`.
- All text through next-intl (`messages/en.json`; English-only MVP, RTL/Arabic planned later via
  next-intl), no hard-coded text, no `/[locale]` URL segment (`src/i18n/config.ts` and `request.ts` are the
  single place a language is added); use logical CSS (`ms-`, `me-`, `start`, `end`; a lint rule enforces
  it) so RTL works when Arabic arrives.
- Money/dates only via `src/lib/format.ts` (tenant currency with its ISO 4217 minor units,
  venue timezone). Payment/expense amounts from the API are always positive; show the entry
  type, not a sign.
- Mobile-first: every screen usable at 360 px; event sheet has a print stylesheet.
- No `dangerouslySetInnerHTML`. Never show prices to roles without `booking.view_prices`.
- Customer duplicate-by-phone is a warning in the UI, not an error.
- Never run git commit/push/merge/rebase/branch commands; list changed files and suggest a
  conventional commit message at the end.
