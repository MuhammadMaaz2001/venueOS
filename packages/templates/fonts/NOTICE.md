# Bundled fonts

These fonts are embedded into every generated PDF (`src/pdf/fonts.ts`), so the output is the same on a
developer laptop, in CI and in the worker container, whatever fonts the machine has
(docs/02-system-design.md, "Documents and email").

| File                                     | Family    | Script subset | Source                  |
| ---------------------------------------- | --------- | ------------- | ----------------------- |
| `noto-sans-latin-{400,700}-normal.woff2` | Noto Sans | Latin         | `@fontsource/noto-sans` 5.3.0 |

Noto Sans is © The Noto Project Authors and licensed under the **SIL Open Font License 1.1** (the full text is
in `OFL-noto-sans.txt` next to the fonts). The licence allows bundling and embedding in documents; the fonts are
not renamed or modified, and are not sold on their own.

**English-only MVP.** Only the Latin font is bundled. To add Arabic later (Gulf market, right-to-left): download
the `@fontsource/noto-naskh-arabic` (or another Arabic family) woff2 files with `npm pack`, copy them and their
licence here, add the entries and the Arabic `unicode-range` to `src/pdf/fonts.ts`, and add the Arabic version of
the templates. The renderer already sets `dir="rtl"` for Arabic (`src/direction.ts`).

To update: download the new `@fontsource/*` package version with `npm pack`, copy the same woff2 files and the
`LICENSE` file, and change the version above.
