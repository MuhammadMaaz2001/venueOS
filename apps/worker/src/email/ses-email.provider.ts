import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { EmailProviderError, formatAddress } from './email-provider';
import type { EmailProvider, OutgoingEmail, SendResult } from './email-provider';

/** The one method of the AWS client this provider uses (tests pass a fake). */
export interface SesClientLike {
  send(command: SendEmailCommand): Promise<Pick<SendEmailCommandOutput, 'MessageId'>>;
}

const REJECTED_ERRORS = new Set([
  'MessageRejected',
  'BadRequestException',
  'MailFromDomainNotVerifiedException',
  'NotFoundException',
]);

/** Map an AWS SDK error onto our two codes. Only the error's name is read, never its message. */
function classify(error: unknown): EmailProviderError {
  const { name } = (error ?? {}) as { name?: unknown };
  return new EmailProviderError(
    typeof name === 'string' && REJECTED_ERRORS.has(name)
      ? 'PROVIDER_REJECTED'
      : 'PROVIDER_UNAVAILABLE',
  );
}

/** AWS SES v2. Credentials come from the standard AWS provider chain (task role in AWS, never from env files). */
export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses' as const;
  private readonly client: SesClientLike;

  constructor(options: { region: string; client?: SesClientLike }) {
    this.client = options.client ?? new SESv2Client({ region: options.region });
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    try {
      const output = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: formatAddress(message.from.name, message.from.address),
          Destination: { ToAddresses: [message.to] },
          ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: message.html, Charset: 'UTF-8' },
                Text: { Data: message.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      return { providerRef: output.MessageId ?? '' };
    } catch (error) {
      throw classify(error);
    }
  }
}
