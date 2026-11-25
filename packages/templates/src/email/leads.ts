import type { EmailTemplateDefinition } from './types.js';

// Internal mails of the leads module (docs/05 section 14: "New lead / follow-up due / hold expiring -> assigned agent").
// Sent under the tenant's name to a staff member. Every variable is a string; the sender fills "Not given" / "Not set"
// for what the inquiry does not say. `leadUrl` is a plain link built from APP_ORIGIN (it carries no token).

/**
 * `lead.assigned`: variables `assigneeName`, `assignedBy`, `customerName`, `eventType`, `venueName`, `preferredDate`,
 * `guests`, `source`, `followUpAt`, `leadUrl`.
 */
export const leadAssigned: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'New lead assigned to you: {{ customerName }}',
      html: '<p>Hello {{ assigneeName }},</p><p>{{ assignedBy }} assigned you an inquiry from <strong>{{ customerName }}</strong> ({{ eventType }} at {{ venueName }}).</p><ul><li>Preferred date: {{ preferredDate }}</li><li>Guests: {{ guests }}</li><li>Source: {{ source }}</li><li>Next follow-up: {{ followUpAt }}</li></ul><p><a href="{{ leadUrl }}">Open the lead</a></p>',
      text: 'Hello {{ assigneeName }},\n\n{{ assignedBy }} assigned you an inquiry from {{ customerName }} ({{ eventType }} at {{ venueName }}).\n\nPreferred date: {{ preferredDate }}\nGuests: {{ guests }}\nSource: {{ source }}\nNext follow-up: {{ followUpAt }}\n\nOpen the lead: {{ leadUrl }}\n',
    },
  },
};

/**
 * `lead.follow-up-due`: variables `assigneeName`, `customerName`, `eventType`, `venueName`, `stage`, `followUpAt`,
 * `leadUrl`. Sent once for each follow-up time that passes.
 */
export const leadFollowUpDue: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: 'Follow-up due: {{ customerName }}',
      html: '<p>Hello {{ assigneeName }},</p><p>The follow-up with <strong>{{ customerName }}</strong> ({{ eventType }} at {{ venueName }}) was due {{ followUpAt }}. The lead is at the stage "{{ stage }}".</p><p><a href="{{ leadUrl }}">Open the lead</a>, record what happened and set the next follow-up.</p>',
      text: 'Hello {{ assigneeName }},\n\nThe follow-up with {{ customerName }} ({{ eventType }} at {{ venueName }}) was due {{ followUpAt }}. The lead is at the stage "{{ stage }}".\n\nOpen the lead, record what happened and set the next follow-up: {{ leadUrl }}\n',
    },
  },
};
