# Bundled UI fonts

Loaded with `next/font/local` (`src/app/fonts.ts`): self-hosted, no download at build or run time.

| File                                              | Family                                         | Use                           |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| `noto-naskh-arabic-arabic-{400,700}-normal.woff2` | Noto Naskh Arabic (Arabic subset, covers Urdu) | Urdu UI text                  |
| `noto-sans-latin-{400,700}-normal.woff2`          | Noto Sans (Latin subset)                       | Latin text, digits, English UI |

Why Naskh and not Nastaliq for the UI: Nastaliq glyphs are tall and diagonal and need a very large line
height, which breaks fixed-height controls (buttons, inputs, table rows, badges) and is hard to read at 12-14
px. Naskh keeps the vertical rhythm of Latin text and mixes cleanly with Latin names and digits. Nastaliq is
kept for generated documents (`packages/templates`).

Both families are (c) The Noto Project Authors, **SIL Open Font License 1.1** (`OFL-*.txt`). They are copies of
the files in `packages/templates/fonts` (same `@fontsource/*` 5.3.0 sources), not modified or renamed.
