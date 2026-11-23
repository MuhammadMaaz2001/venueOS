export { TemplateError } from './render.js';
export type { TemplateErrorCode } from './render.js';
export {
  UnknownTemplateError,
  hasEmailTemplate,
  listEmailTemplates,
  renderEmail,
} from './email/render-email.js';
export type { EmailTemplateSource, RenderedEmail } from './email/types.js';
