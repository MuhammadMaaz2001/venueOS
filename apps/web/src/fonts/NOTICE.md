# Bundled UI font

Loaded with `next/font/local` (`src/app/fonts.ts`): self-hosted, no download at build or run time.

| File                                     | Family    | Use                          |
| ---------------------------------------- | --------- | ---------------------------- |
| `noto-sans-latin-{400,700}-normal.woff2` | Noto Sans | Latin text and digits (UI)   |

Noto Sans is (c) The Noto Project Authors, **SIL Open Font License 1.1** (`OFL-noto-sans.txt`). The files are a
copy of those in `packages/templates/fonts` (same `@fontsource/noto-sans` 5.3.0 source), not modified or renamed.

**English-only MVP.** To add Arabic later (Gulf market, right-to-left): put the Arabic family's woff2 files and
licence here (Naskh is the right style for dense UI: Nastaliq glyphs are tall and diagonal and break fixed-height
controls and small sizes), load them in `src/app/fonts.ts`, add the variable to `--font-sans` in `globals.css`
after `--font-latin`, and add a `messages/ar.json` (see `src/i18n/config.ts`).
