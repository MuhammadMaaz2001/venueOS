import type { EmailTemplateDefinition } from './types.js';

// Account and staff mails of P0-4 (docs/04-security.md section 1). Links are built by the API from APP_ORIGIN
// and passed as variables; the ones that carry a token (`verifyUrl`, `resetUrl`, `acceptUrl`) are SEALED
// secret variables, never stored in plain text. Account mails are sent under the product name.

/** `auth.verify-email`: variables `name`, `verifyUrl` (secret), `hours`. */
export const verifyEmail: EmailTemplateDefinition = {
  sender: 'product',
  locales: {
    en: {
      subject: 'Confirm your email address',
      html: '<p>Hello {{ name }},</p><p>Confirm your email address to finish setting up your venueOS workspace.</p><p><a href="{{ verifyUrl }}">Confirm my email</a></p><p>The link works for {{ hours }} hours. If you did not sign up, you can ignore this message.</p>',
      text: 'Hello {{ name }},\n\nConfirm your email address to finish setting up your venueOS workspace:\n{{ verifyUrl }}\n\nThe link works for {{ hours }} hours. If you did not sign up, you can ignore this message.\n',
    },
  },
};

/** `auth.account-exists`: sent when someone signs up with an address that already has an account. */
export const accountExists: EmailTemplateDefinition = {
  sender: 'product',
  locales: {
    en: {
      subject: 'You already have a venueOS account',
      html: '<p>Someone tried to create a venueOS account with this email address, but one already exists.</p><p>If it was you, <a href="{{ loginUrl }}">log in</a>, or <a href="{{ forgotUrl }}">reset your password</a> if you have forgotten it. If it was not you, you can ignore this message: nothing has changed.</p>',
      text: 'Someone tried to create a venueOS account with this email address, but one already exists.\n\nIf it was you, log in: {{ loginUrl }}\nForgotten your password? {{ forgotUrl }}\n\nIf it was not you, you can ignore this message: nothing has changed.\n',
    },
  },
};

/** `auth.password-reset`: variables `name`, `resetUrl` (secret), `minutes`. */
export const passwordReset: EmailTemplateDefinition = {
  sender: 'product',
  locales: {
    en: {
      subject: 'Reset your password',
      html: '<p>Hello {{ name }},</p><p>We received a request to reset your venueOS password.</p><p><a href="{{ resetUrl }}">Choose a new password</a></p><p>The link works once and expires in {{ minutes }} minutes. If you did not ask for this, you can ignore this message; your password stays as it is.</p>',
      text: 'Hello {{ name }},\n\nWe received a request to reset your venueOS password. Choose a new one here:\n{{ resetUrl }}\n\nThe link works once and expires in {{ minutes }} minutes. If you did not ask for this, you can ignore this message; your password stays as it is.\n',
    },
  },
};

/** `staff.invite`: sent under the inviting tenant's name. Variables `inviterName`, `tenantName`, `roleName`, `acceptUrl` (secret), `days`. */
export const staffInvite: EmailTemplateDefinition = {
  sender: 'tenant',
  locales: {
    en: {
      subject: '{{ inviterName }} invited you to join {{ tenantName }}',
      html: '<p>{{ inviterName }} invited you to join <strong>{{ tenantName }}</strong> on venueOS as {{ roleName }}.</p><p><a href="{{ acceptUrl }}">Accept the invitation</a></p><p>The invitation expires in {{ days }} days. If you were not expecting it, you can ignore this message.</p>',
      text: '{{ inviterName }} invited you to join {{ tenantName }} on venueOS as {{ roleName }}.\n\nAccept the invitation:\n{{ acceptUrl }}\n\nThe invitation expires in {{ days }} days. If you were not expecting it, you can ignore this message.\n',
    },
  },
};
