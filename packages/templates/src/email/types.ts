/** One language version of an email: three templates sharing the same variables. */
export interface EmailTemplateSource {
  /** Plain text with `{{ }}` placeholders. */
  subject: string;
  /** HTML body fragment (the renderer wraps it in a document). Literal markup, escaped values. */
  html: string;
  /** Plain-text alternative. */
  text: string;
}

export interface RenderedEmail {
  subject: string;
  /** A complete HTML document with `lang` and `dir` set for the locale. */
  html: string;
  text: string;
  /** The locale that was actually used (after fallback). */
  locale: string;
}
