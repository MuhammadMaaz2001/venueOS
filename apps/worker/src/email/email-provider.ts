/** Injection token for the configured provider (EMAIL_PROVIDER=smtp|ses). Tests override it. */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface OutgoingEmail {
  /** Sender address and display name (the tenant's name). */
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  /** The provider's message id (SES MessageId, SMTP message id). Stored in `message_logs.provider_ref`. */
  providerRef: string;
}

/**
 * Sends one message. Implementations must throw `EmailProviderError` for every failure, with a short
 * code and without provider text (it can contain addresses and credentials).
 */
export interface EmailProvider {
  readonly name: 'smtp' | 'ses';
  send(message: OutgoingEmail): Promise<SendResult>;
}

export type EmailProviderErrorCode = 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED';

export class EmailProviderError extends Error {
  constructor(readonly code: EmailProviderErrorCode) {
    super(code);
    this.name = 'EmailProviderError';
  }
}

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f"<>\\]+/g;

/** A display name that is safe in a From header: no control characters, quotes or angle brackets. */
export function sanitizeDisplayName(name: string, fallback = 'venueOS'): string {
  const clean = name.replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return clean || fallback;
}

/** `"Name" <address>`, with the name RFC 2047-encoded when it is not plain ASCII. */
export function formatAddress(name: string, address: string): string {
  const clean = sanitizeDisplayName(name);
  const ascii = /^[ -~]*$/.test(clean);
  const display = ascii
    ? `"${clean}"`
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
  return `${display} <${address}>`;
}
