import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EmailProviderError, sanitizeDisplayName } from './email-provider';
import type { EmailProvider, OutgoingEmail, SendResult } from './email-provider';

const UNAVAILABLE_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ENOTFOUND',
  'EAUTH',
]);

/** Map a nodemailer error onto our two codes. Only the error's codes are read, never its message. */
function classify(error: unknown): EmailProviderError {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) {
    return new EmailProviderError('PROVIDER_UNAVAILABLE');
  }
  if (typeof responseCode === 'number' && responseCode >= 500) {
    return new EmailProviderError('PROVIDER_REJECTED');
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE')
    return new EmailProviderError('PROVIDER_REJECTED');
  return new EmailProviderError('PROVIDER_UNAVAILABLE');
}

/** SMTP through nodemailer: Mailpit in development (smtp://localhost:1025), any relay elsewhere. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private readonly transporter: Transporter;

  constructor(url: string) {
    this.transporter = createTransport({
      url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: { name: sanitizeDisplayName(message.from.name), address: message.from.address },
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return { providerRef: String(info.messageId ?? '') };
    } catch (error) {
      throw classify(error);
    }
  }

  close(): void {
    this.transporter.close();
  }
}
