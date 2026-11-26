/** A PDF template: literal, trusted markup with `{{ }}` placeholders (escaped on output). */
export interface PdfTemplateDefinition {
  /** Document title (plain text with placeholders). */
  title: string;
  /** Page and layout CSS. Literal text from this repository; never takes variables. */
  css: string;
  /** Body markup with `{{ a.b }}` placeholders. */
  body: string;
  /**
   * For a document with repeated parts (sessions, lines) that the placeholder syntax cannot express: builds the body in code.
   * It must pass every value through `escape`; the literal markup is trusted because it comes from this repository.
   */
  build?: (vars: unknown, escape: (value: string) => string) => string;
}

export interface RenderedPdfHtml {
  /** A complete HTML document. */
  html: string;
  /** Language code used for `lang` (after fallback to `en`). */
  lang: string;
  dir: 'ltr' | 'rtl';
}
