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
