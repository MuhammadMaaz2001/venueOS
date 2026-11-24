// The MVP is English-only. The scaffolding for more languages is kept on purpose: a language is added by putting
// its code in LOCALES, its texts in messages/<code>.json (same keys as en.json; a test checks that), its font in
// app/fonts.ts, and, if it is written right to left (Arabic, for the Gulf market), its code in RTL_LOCALES.
// Components never hard-code a language, a direction or a text.
export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Locales written right to left (none yet; Arabic is planned). */
const RTL_LOCALES: readonly Locale[] = [];

export function isLocale(value: string | undefined | null): value is Locale {
  return LOCALES.some((l) => l === value);
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}
