/** One language version of an email: three templates sharing the same variables. */
export interface EmailTemplateSource {
  /** Plain text with `{{ }}` placeholders. */
  subject: string;
  /** HTML body fragment (the renderer wraps it in a document). Literal markup, escaped values. */
  html: string;
  /** Plain-text alternative. */
  text: string;
}

/**
 * Whose name the mail is sent under. `product`: the product name (account mails: verification, password
 * reset, "account exists"; a tenant's name on those would look like phishing). `tenant`: the name of the
 * tenant the message belongs to (invitations, booking mails).
 */
export type EmailSender = 'product' | 'tenant';

export interface EmailTemplateDefinition {
  sender: EmailSender;
  /** By language code (only `en` in the MVP); `en` is the fallback for every other locale, so a language is added by adding its version here. */
  locales: Readonly<Record<string, EmailTemplateSource>>;
}

export interface RenderedEmail {
  subject: string;
  /** A complete HTML document with `lang` and `dir` set for the locale. */
  html: string;
  text: string;
  /** The locale that was actually used (after fallback). */
  locale: string;
  sender: EmailSender;
}
