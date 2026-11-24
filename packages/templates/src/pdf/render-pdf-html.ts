import { escapeHtml, renderTemplate } from '../render.js';
import { pdfFontFaceCss } from './fonts.js';
import { sampleDocument } from './sample.js';
import type { PdfTemplateDefinition, RenderedPdfHtml } from './types.js';

/** Thrown when no PDF template of that name exists. Permanent. */
export class UnknownPdfTemplateError extends Error {
  constructor(readonly template: string) {
    super(`Unknown PDF template "${template}"`);
    this.name = 'UnknownPdfTemplateError';
  }
}

const REGISTRY: Readonly<Record<string, PdfTemplateDefinition>> = Object.freeze({
  sample: sampleDocument,
});

const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
const LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export function hasPdfTemplate(name: string): boolean {
  return Object.hasOwn(REGISTRY, name);
}

/**
 * Render a PDF template into a complete, self-contained HTML document: A4 page rules, the bundled fonts as
 * data: URLs, no scripts, no external references. Every substituted value is HTML-escaped; the literal
 * template text comes from this repository.
 *
 * @throws UnknownPdfTemplateError when the template does not exist
 * @throws TemplateError (from ../render) when a variable is missing or the template is malformed
 */
export function renderPdfHtml(name: string, locale: string, vars: unknown): RenderedPdfHtml {
  const definition = hasPdfTemplate(name) ? REGISTRY[name] : undefined;
  if (!definition) throw new UnknownPdfTemplateError(name);

  const language = (LOCALE.test(locale) ? locale : 'en').toLowerCase().split('-')[0] ?? 'en';
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  const body = renderTemplate(definition.body, vars, escapeHtml);
  const title = renderTemplate(definition.title, vars, escapeHtml);

  const html =
    `<!doctype html>\n<html lang="${language}" dir="${dir}">\n<head>\n<meta charset="utf-8">\n` +
    // No network: the page may load nothing from outside (the worker also blocks every request).
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">\n` +
    `<title>${title}</title>\n<style>\n${pdfFontFaceCss()}\n${definition.css}\n</style>\n</head>\n` +
    `<body>\n${body}\n</body>\n</html>\n`;
  return { html, lang: language, dir };
}
