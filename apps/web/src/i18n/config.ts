export const LOCALES = ['en', 'ur'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

// Cookie that holds the user's language. There is no /[locale] URL segment.
export const LOCALE_COOKIE = 'NEXT_LOCALE';

const RTL_LOCALES: readonly Locale[] = ['ur'];

export function isLocale(value: string | undefined | null): value is Locale {
  return LOCALES.some((l) => l === value);
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

/** Names of the languages in their own script (shown in the language switcher, never translated). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', ur: 'اردو' };
