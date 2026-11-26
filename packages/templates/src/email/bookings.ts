import type { EmailTemplateDefinition } from './types.js';

// Mails of the quotation and booking modules (docs/05 section 14). Sent under the tenant's name.

/**
 * `quotation.send`: to the CUSTOMER, with the quotation PDF attached. Variables `customerName`, `tenantName`, `agentName`,
 * `quotationNumber`, `version`, `validUntil`, `grandTotal` (with the currency), `summary` (one line per session) and `message`
 * (a personal note of the sender; may be empty).
 */
export const quotationSend: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Quotation {{ quotationNumber }} from {{ tenantName }}',
      html: '<p>Dear {{ customerName }},</p><p>Thank you for your interest in {{ tenantName }}. Your quotation <strong>{{ quotationNumber }}</strong> (version {{ version }}) is attached as a PDF.</p><p style="white-space:pre-line">{{ summary }}</p><p><strong>Total: {{ grandTotal }}</strong><br>Valid until {{ validUntil }}.</p><p style="white-space:pre-line">{{ message }}</p><p>Kind regards,<br>{{ agentName }}<br>{{ tenantName }}</p>',
      text: 'Dear {{ customerName }},\n\nThank you for your interest in {{ tenantName }}. Your quotation {{ quotationNumber }} (version {{ version }}) is attached as a PDF.\n\n{{ summary }}\n\nTotal: {{ grandTotal }}\nValid until {{ validUntil }}.\n\n{{ message }}\n\nKind regards,\n{{ agentName }}\n{{ tenantName }}\n',
    },
  },
};

/** `hold.expired`: to the agent who made the hold. Variables `agentName`, `bookingNumber`, `customerName`, `firstSession`, `bookingUrl`. */
export const holdExpired: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Hold expired: {{ bookingNumber }} ({{ customerName }})',
      html: '<p>Hello {{ agentName }},</p><p>The hold of booking <strong>{{ bookingNumber }}</strong> for {{ customerName }} (first session {{ firstSession }}) has expired and the dates are free again.</p><p><a href="{{ bookingUrl }}">Open the booking</a> to hold it again if the dates are still free.</p>',
      text: 'Hello {{ agentName }},\n\nThe hold of booking {{ bookingNumber }} for {{ customerName }} (first session {{ firstSession }}) has expired and the dates are free again.\n\nOpen the booking to hold it again if the dates are still free: {{ bookingUrl }}\n',
    },
  },
};

/** `hold.expiring`: a heads-up before the hold ends. Variables `agentName`, `bookingNumber`, `customerName`, `expiresAt`, `bookingUrl`. */
export const holdExpiring: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Hold ending soon: {{ bookingNumber }} ({{ customerName }})',
      html: '<p>Hello {{ agentName }},</p><p>The hold of booking <strong>{{ bookingNumber }}</strong> for {{ customerName }} ends {{ expiresAt }}.</p><p><a href="{{ bookingUrl }}">Open the booking</a> to extend the hold or confirm it.</p>',
      text: 'Hello {{ agentName }},\n\nThe hold of booking {{ bookingNumber }} for {{ customerName }} ends {{ expiresAt }}.\n\nOpen the booking to extend the hold or confirm it: {{ bookingUrl }}\n',
    },
  },
};
