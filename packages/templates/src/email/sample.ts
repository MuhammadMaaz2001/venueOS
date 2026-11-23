import type { EmailTemplateSource } from './types.js';

/**
 * `sample.hello`: the one template of P0-6a, used by the tests and as the pattern for real ones
 * (booking confirmation, receipt, reminders arrive with their modules). Tenant-editable templates
 * (`message_templates`) are a later task.
 */
export const sampleHello: Record<string, EmailTemplateSource> = {
  en: {
    subject: 'Hello {{ name }}, your booking {{ booking.number }}',
    html: '<p>Hello {{ name }},</p><p>Your booking <strong>{{ booking.number }}</strong> at {{ venue }} is confirmed.</p>',
    text: 'Hello {{ name }},\n\nYour booking {{ booking.number }} at {{ venue }} is confirmed.\n',
  },
  ur: {
    subject: 'السلام علیکم {{ name }}، آپ کی بکنگ {{ booking.number }}',
    html: '<p>السلام علیکم {{ name }}،</p><p>{{ venue }} میں آپ کی بکنگ <strong>{{ booking.number }}</strong> کنفرم ہو گئی ہے۔</p>',
    text: 'السلام علیکم {{ name }}،\n\n{{ venue }} میں آپ کی بکنگ {{ booking.number }} کنفرم ہو گئی ہے۔\n',
  },
};
