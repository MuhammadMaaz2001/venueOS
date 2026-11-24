import { readFileSync } from 'node:fs';
import path from 'node:path';

// The bundled fonts (packages/templates/fonts, SIL OFL 1.1, see fonts/NOTICE.md), as @font-face rules with
// the font data inlined as data: URLs. A PDF page is rendered with network access switched off, so nothing
// may be fetched: every glyph must come from here or from the machine.

const FONT_DIR = path.join(__dirname, '..', '..', 'fonts');

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

interface FontFile {
  family: string;
  weight: 400 | 700;
  file: string;
  range: string;
}

const FONTS: readonly FontFile[] = [
  {
    family: 'Noto Sans',
    weight: 400,
    file: 'noto-sans-latin-400-normal.woff2',
    range: LATIN_RANGE,
  },
  {
    family: 'Noto Sans',
    weight: 700,
    file: 'noto-sans-latin-700-normal.woff2',
    range: LATIN_RANGE,
  },
];

let cached: string | undefined;

/** The `@font-face` rules of every bundled font, with the data inlined. Built once, then reused. */
export function pdfFontFaceCss(): string {
  cached ??= FONTS.map((font) => {
    const data = readFileSync(path.join(FONT_DIR, font.file)).toString('base64');
    return (
      `@font-face{font-family:'${font.family}';font-weight:${font.weight};font-style:normal;` +
      `font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');` +
      `unicode-range:${font.range};}`
    );
  }).join('\n');
  return cached;
}

/** File names of the bundled fonts (tests check that every one exists and has a licence next to it). */
export const BUNDLED_FONT_FILES: readonly string[] = FONTS.map((f) => f.file);
