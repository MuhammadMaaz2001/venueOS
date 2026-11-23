import { describe, expect, it } from 'vitest';
import { AUDIT_REDACTED, maskSensitive } from '../common/audit/mask-sensitive';

describe('maskSensitive', () => {
  it('redacts secrets and credentials at any depth, in arrays too', () => {
    const out = maskSensitive({
      password: 'p',
      passwordHash: 'h',
      nested: { resetToken: 't', apiKey: 'k', client_secret: 's', cnic: '35202-1234567-1' },
      list: [{ authorization: 'Bearer x' }, { cookie: 'c=1' }],
    });
    expect(out).toEqual({
      password: AUDIT_REDACTED,
      passwordHash: AUDIT_REDACTED,
      nested: {
        resetToken: AUDIT_REDACTED,
        apiKey: AUDIT_REDACTED,
        client_secret: AUDIT_REDACTED,
        cnic: AUDIT_REDACTED,
      },
      list: [{ authorization: AUDIT_REDACTED }, { cookie: AUDIT_REDACTED }],
    });
  });

  it('keeps only a hint of phone numbers and emails', () => {
    expect(
      maskSensitive({ phone: '+923001234567', email: 'ayesha@example.com', ownerEmail: 'b@x.pk' }),
    ).toEqual({
      phone: '***4567',
      email: 'a***@example.com',
      ownerEmail: 'b***@x.pk',
    });
    expect(maskSensitive({ phone: null, email: undefined })).toEqual({ phone: null, email: null });
    expect(maskSensitive({ phone: '12' })).toEqual({ phone: AUDIT_REDACTED });
  });

  it('does not over-redact business fields that merely contain a word like "token"', () => {
    expect(
      maskSensitive({ tokenAmount: '5000', name: 'Token Hall', permissions: ['a.b'] }),
    ).toEqual({
      tokenAmount: '5000',
      name: 'Token Hall',
      permissions: ['a.b'],
    });
  });

  it('turns dates, bigints and Decimal-like values into plain JSON and drops undefined', () => {
    const decimalLike = { toJSON: () => '125000.00' };
    expect(
      maskSensitive({
        at: new Date('2027-02-14T14:00:00.000Z'),
        big: 10n,
        total: decimalLike,
        gone: undefined,
        nan: Number.NaN,
      }),
    ).toEqual({ at: '2027-02-14T14:00:00.000Z', big: '10', total: '125000.00', nan: null });
  });

  it('bounds the depth', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(JSON.stringify(maskSensitive(deep))).toContain('[TRUNCATED]');
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', a: { phone: '+923001234567' } };
    maskSensitive(input);
    expect(input).toEqual({ password: 'p', a: { phone: '+923001234567' } });
  });
});
