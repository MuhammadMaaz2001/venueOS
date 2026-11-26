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

/**
 * `receipt.sent`: to the CUSTOMER, with the receipt PDF attached. Variables `customerName`, `tenantName`, `receiptNo`,
 * `amount` (with the currency), `method`, `receivedOn`, `bookingNumber`.
 */
export const receiptSent: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Receipt {{ receiptNo }} from {{ tenantName }}',
      html: '<p>Dear {{ customerName }},</p><p>Thank you. We have received <strong>{{ amount }}</strong> ({{ method }}) on {{ receivedOn }} for booking {{ bookingNumber }}. Your receipt <strong>{{ receiptNo }}</strong> is attached as a PDF.</p><p>Kind regards,<br>{{ tenantName }}</p>',
      text: 'Dear {{ customerName }},\n\nThank you. We have received {{ amount }} ({{ method }}) on {{ receivedOn }} for booking {{ bookingNumber }}. Your receipt {{ receiptNo }} is attached as a PDF.\n\nKind regards,\n{{ tenantName }}\n',
    },
  },
};

/**
 * `payment.due`: a reminder to the CUSTOMER that a payment of the schedule is due. Variables `customerName`, `tenantName`,
 * `bookingNumber`, `label` (Token, Advance, Balance), `amount` (what is still owed on it, with the currency), `dueDate`.
 */
export const paymentDue: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Payment due {{ dueDate }}: booking {{ bookingNumber }}',
      html: '<p>Dear {{ customerName }},</p><p>This is a friendly reminder that the <strong>{{ label }}</strong> payment of <strong>{{ amount }}</strong> for booking {{ bookingNumber }} is due on {{ dueDate }}. If you have already paid, thank you, and please ignore this message.</p><p>Kind regards,<br>{{ tenantName }}</p>',
      text: 'Dear {{ customerName }},\n\nThis is a friendly reminder that the {{ label }} payment of {{ amount }} for booking {{ bookingNumber }} is due on {{ dueDate }}. If you have already paid, thank you, and please ignore this message.\n\nKind regards,\n{{ tenantName }}\n',
    },
  },
};
