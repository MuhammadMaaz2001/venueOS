import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { EmailProviderError, formatAddress, sanitizeDisplayName } from '../email/email-provider';
import type { OutgoingEmail } from '../email/email-provider';
import { SesEmailProvider } from '../email/ses-email.provider';
import type { SesClientLike } from '../email/ses-email.provider';
import { SmtpEmailProvider } from '../email/smtp-email.provider';

const message: OutgoingEmail = {
  from: { name: 'Royal Hall', address: 'bookings@venueos.app' },
  to: 'ali@example.test',
  replyTo: 'owner@royal.example.test',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
};

describe('display names', () => {
  it('drops control characters, quotes and angle brackets, and falls back when nothing is left', () => {
    expect(sanitizeDisplayName('Royal <Hall> "Banquet"\r\nBcc: x@y.test')).toBe(
      'Royal Hall Banquet Bcc: x@y.test',
    );
    expect(sanitizeDisplayName('"<>"')).toBe('venueOS');
    expect(sanitizeDisplayName('x'.repeat(300))).toHaveLength(100);
  });

  it('formats ASCII names quoted and other names as RFC 2047', () => {
    expect(formatAddress('Royal Hall', 'a@b.test')).toBe('"Royal Hall" <a@b.test>');
    const encoded = formatAddress('شاہی ہال', 'a@b.test');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b\.test>$/);
    expect(encoded).not.toMatch(/[^ -~]/);
  });
});

describe('SesEmailProvider', () => {
  function fakeClient(result: () => unknown): { client: SesClientLike; sent: SendEmailCommand[] } {
    const sent: SendEmailCommand[] = [];
    return {
      sent,
      client: {
        send: (command) => {
          sent.push(command);
          const value = result();
          return value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve(value as { MessageId?: string });
        },
      },
    };
  }

  it('sends one multipart message and returns the SES message id', async () => {
    const { client, sent } = fakeClient(() => ({ MessageId: 'ses-123' }));
    const result = await new SesEmailProvider({ region: 'ap-south-1', client }).send(message);
    expect(result).toEqual({ providerRef: 'ses-123' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({
      FromEmailAddress: '"Royal Hall" <bookings@venueos.app>',
      Destination: { ToAddresses: ['ali@example.test'] },
      ReplyToAddresses: ['owner@royal.example.test'],
      Content: {
        Simple: {
          Subject: { Data: 'Hello', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hi</p>', Charset: 'UTF-8' },
            Text: { Data: 'Hi', Charset: 'UTF-8' },
          },
        },
      },
    });
  });

  it('omits Reply-To when there is none', async () => {
    const { client, sent } = fakeClient(() => ({ MessageId: 'x' }));
    const without: OutgoingEmail = { ...message };
    delete without.replyTo;
    await new SesEmailProvider({ region: 'r', client }).send(without);
    expect(sent[0]?.input.ReplyToAddresses).toBeUndefined();
  });

  it('maps SES errors to short codes and never carries provider text', async () => {
    const rejected = Object.assign(new Error('Email address is not verified: ali@example.test'), {
      name: 'MessageRejected',
    });
    const throttled = Object.assign(new Error('Rate exceeded'), {
      name: 'TooManyRequestsException',
    });
    for (const [error, code] of [
      [rejected, 'PROVIDER_REJECTED'],
      [throttled, 'PROVIDER_UNAVAILABLE'],
      [new Error('socket hang up'), 'PROVIDER_UNAVAILABLE'],
    ] as const) {
      const { client } = fakeClient(() => error);
      const caught = await new SesEmailProvider({ region: 'r', client })
        .send(message)
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(EmailProviderError);
      expect((caught as EmailProviderError).code).toBe(code);
      expect((caught as EmailProviderError).message).toBe(code);
    }
  });
});

describe('SmtpEmailProvider', () => {
  it('reports an unreachable server as PROVIDER_UNAVAILABLE', async () => {
    const provider = new SmtpEmailProvider('smtp://127.0.0.1:1');
    const caught = await provider.send(message).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(EmailProviderError);
    expect((caught as EmailProviderError).code).toBe('PROVIDER_UNAVAILABLE');
    provider.close();
  });
});
