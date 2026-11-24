import type { EmailTemplateDefinition } from './types.js';

/**
 * `sample.hello`: the template of P0-6a, used by the tests as the pattern for real ones. Tenant-editable
 * templates (`message_templates`) are a later task.
 */
export const sampleHello: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Hello {{ name }}, your booking {{ booking.number }}',
      html: '<p>Hello {{ name }},</p><p>Your booking <strong>{{ booking.number }}</strong> at {{ venue }} is confirmed.</p>',
      text: 'Hello {{ name }},\n\nYour booking {{ booking.number }} at {{ venue }} is confirmed.\n',
    },
  },
};
