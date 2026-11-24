/**
 * Languages written right to left. English is the only language of the MVP; Arabic (the Gulf market) is planned,
 * so documents and emails already get `dir="rtl"` for it. Adding Arabic later is a template version, a messages
 * file in the web app and an Arabic font in `fonts/` (see fonts/NOTICE.md).
 */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he']);

export function textDirection(language: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(language.toLowerCase().split('-')[0] ?? '') ? 'rtl' : 'ltr';
}
