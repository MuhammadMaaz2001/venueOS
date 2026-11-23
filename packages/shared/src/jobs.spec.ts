import { describe, expect, it } from 'vitest';
import { emailSendPayloadSchema, enqueueEmailInputSchema } from './jobs.js';
import { maskEmail } from './mask.js';

describe('emailSendPayloadSchema', () => {
  it('accepts exactly tenantId and messageKey', () => {
    expect(emailSendPayloadSchema.parse({ tenantId: 't1', messageKey: 'm-1' })).toEqual({
      tenantId: 't1',
      messageKey: 'm-1',
    });
  });

  it('rejects any extra key, so customer data cannot ride along into pgboss.job', () => {
    expect(
      emailSendPayloadSchema.safeParse({ tenantId: 't1', messageKey: 'm1', to: 'a@b.test' })
        .success,
    ).toBe(false);
  });

  it('rejects missing or malformed identifiers', () => {
    expect(emailSendPayloadSchema.safeParse({ tenantId: 't1' }).success).toBe(false);
    expect(emailSendPayloadSchema.safeParse({ tenantId: "t1'; --", messageKey: 'm' }).success).toBe(
      false,
    );
  });
});

describe('enqueueEmailInputSchema', () => {
  const base = { to: 'ali@example.test', template: 'sample.hello', locale: 'en' };

  it('defaults vars to an empty object and accepts nested values', () => {
    expect(enqueueEmailInputSchema.parse(base).vars).toEqual({});
    const parsed = enqueueEmailInputSchema.parse({
      ...base,
      vars: { name: 'Ali', booking: { number: 'BK-1', guests: 250, paid: false } },
    });
    expect(parsed.vars).toEqual({
      name: 'Ali',
      booking: { number: 'BK-1', guests: 250, paid: false },
    });
  });

  it('rejects bad addresses, template names, locales and variable names', () => {
    expect(enqueueEmailInputSchema.safeParse({ ...base, to: 'not-an-address' }).success).toBe(
      false,
    );
    expect(enqueueEmailInputSchema.safeParse({ ...base, template: '../etc' }).success).toBe(false);
    expect(enqueueEmailInputSchema.safeParse({ ...base, locale: 'en US' }).success).toBe(false);
    expect(enqueueEmailInputSchema.safeParse({ ...base, vars: { 'a b': 'x' } }).success).toBe(
      false,
    );
    expect(enqueueEmailInputSchema.safeParse({ ...base, vars: { a: null } }).success).toBe(false);
  });

  it('rejects oversized variables', () => {
    const big = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(1500)]),
    );
    expect(enqueueEmailInputSchema.safeParse({ ...base, vars: big }).success).toBe(false);
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskEmail('ali.khan@example.com')).toBe('a***@example.com');
  });

  it('masks anything that is not an address', () => {
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('nope')).toBe('***');
  });
});
