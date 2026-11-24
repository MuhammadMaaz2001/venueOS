export { TemplateError } from './render.js';
export type { TemplateErrorCode } from './render.js';
export {
  PRODUCT_NAME,
  UnknownTemplateError,
  hasEmailTemplate,
  listEmailTemplates,
  renderEmail,
} from './email/render-email.js';
export type { EmailSender, EmailTemplateSource, RenderedEmail } from './email/types.js';
export { UnknownPdfTemplateError, hasPdfTemplate, renderPdfHtml } from './pdf/render-pdf-html.js';
export { BUNDLED_FONT_FILES, pdfFontFaceCss } from './pdf/fonts.js';
export type { RenderedPdfHtml } from './pdf/types.js';
