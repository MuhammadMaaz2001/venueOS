# Bundled fonts

These fonts are embedded into every generated PDF (`src/pdf/fonts.ts`), so the output is the same on a
developer laptop, in CI and in the worker container, whatever fonts the machine has. Chromium shapes Urdu
(joining, Nastaliq positioning, RTL) from these files (docs/02-system-design.md, "Documents and email").

| File | Family | Script subset | Source |
| --- | --- | --- | --- |
| `noto-nastaliq-urdu-arabic-{400,700}-normal.woff2` | Noto Nastaliq Urdu | Arabic (covers Urdu) | `@fontsource/noto-nastaliq-urdu` 5.3.0 |
| `noto-naskh-arabic-arabic-{400,700}-normal.woff2` | Noto Naskh Arabic | Arabic (covers Urdu) | `@fontsource/noto-naskh-arabic` 5.3.0 |
| `noto-sans-latin-{400,700}-normal.woff2` | Noto Sans | Latin | `@fontsource/noto-sans` 5.3.0 |

All three are © The Noto Project Authors and licensed under the **SIL Open Font License 1.1** (the full text
of each is in `OFL-*.txt` next to the fonts). The licence allows bundling and embedding in documents; the
fonts are not renamed or modified, and are not sold on their own.

To update: download the new `@fontsource/*` package version with `npm pack`, copy the same woff2 files and the
`LICENSE` file, and change the versions above.
