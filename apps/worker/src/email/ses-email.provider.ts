import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
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
      if (message.attachments?.length) return await this.sendRaw(message);
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

  /** A message with attachments is a raw MIME message (SES v2 `Simple` content cannot carry files). */
  private async sendRaw(message: OutgoingEmail): Promise<SendResult> {
    const raw = await new MailComposer({
      from: formatAddress(message.from.name, message.from.address),
      to: message.to,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: (message.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    })
      .compile()
      .build();
    const output = await this.client.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [message.to] },
        Content: { Raw: { Data: raw } },
      }),
    );
    return { providerRef: output.MessageId ?? '' };
  }
}
