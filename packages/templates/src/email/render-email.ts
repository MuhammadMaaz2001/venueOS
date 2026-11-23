import { escapeHtml, escapeSubject, escapeText, renderTemplate } from '../render.js';
import { sampleHello } from './sample.js';
import type { EmailTemplateSource, RenderedEmail } from './types.js';

/** Thrown when no template of that name exists (or none in the locale or in `en`). Permanent. */
export class UnknownTemplateError extends Error {
  constructor(readonly template: string) {
    super(`Unknown email template "${template}"`);
    this.name = 'UnknownTemplateError';
  }
}

const REGISTRY: Readonly<Record<string, Readonly<Record<string, EmailTemplateSource>>>> =
  Object.freeze({
    'sample.hello': sampleHello,
  });

const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
const LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export function hasEmailTemplate(name: string): boolean {
  return Object.hasOwn(REGISTRY, name);
}

export function listEmailTemplates(): string[] {
  return Object.keys(REGISTRY);
}

function pickLocale(
  versions: Readonly<Record<string, EmailTemplateSource>>,
  requested: string,
): string | undefined {
  const wanted = requested.toLowerCase();
  const language = wanted.split('-')[0] ?? wanted;
  return [wanted, language, 'en'].find((l) => Object.hasOwn(versions, l));
}

/**
 * Render an email template into subject, HTML document and text. Every variable is escaped for the
 * place it lands in (HTML body, Subject header, plain text); the literal template text is trusted
 * because it comes from this repository, never from a request.
 *
 * @throws UnknownTemplateError when the template does not exist
 * @throws TemplateError (from ../render) when a variable is missing or the template is malformed
 */
export function renderEmail(name: string, locale: string, vars: unknown): RenderedEmail {
  const versions = hasEmailTemplate(name) ? REGISTRY[name] : undefined;
  const used = versions && LOCALE.test(locale) ? pickLocale(versions, locale) : undefined;
  const source = versions && used ? versions[used] : undefined;
  if (!source || !used) throw new UnknownTemplateError(name);

  const subject = renderTemplate(source.subject, vars, escapeSubject);
  const body = renderTemplate(source.html, vars, escapeHtml);
  const text = renderTemplate(source.text, vars, escapeText);
  const language = used.split('-')[0] ?? used;
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${used}" dir="${dir}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(subject)}</title></head><body>${body}</body></html>`;
  return { subject, html, text, locale: used };
}
