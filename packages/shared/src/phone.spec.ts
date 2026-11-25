import { describe, expect, it } from 'vitest';
import { isE164, normalizePhone, phoneSearchDigits } from './phone.js';

const ok = (input: string, country: string | null, e164: string) =>
  expect(normalizePhone(input, country)).toEqual({ ok: true, e164 });
const fails = (input: string, country: string | null, reason: string) =>
  expect(normalizePhone(input, country)).toEqual({ ok: false, reason });

describe('normalizePhone', () => {
  it('Pakistan: national, international and formatted numbers all become the same E.164', () => {
    for (const typed of [
      '0300 1234567',
      '0300-1234567',
      '03001234567',
      '3001234567',
      '+92 300 1234567',
      '0092 300 1234567',
      '923001234567',
      '(0300) 123 4567',
    ]) {
      ok(typed, 'PK', '+923001234567');
    }
  });

  it('Pakistan landlines drop the trunk zero too', () => {
    ok('042-35761234', 'PK', '+924235761234');
  });

  it('a number with a country code ignores the tenant country', () => {
    ok('+971 50 123 4567', 'PK', '+971501234567');
    ok('+971 50 123 4567', null, '+971501234567');
    ok('+44 7911 123456', 'PK', '+447911123456');
  });

  it('Gulf and other markets use their own rules', () => {
    ok('50 123 4567', 'AE', '+971501234567');
    ok('050 123 4567', 'AE', '+971501234567');
    ok('9123 4567', 'KW', '+96591234567'); // 8 digits, no trunk digit
    ok('(415) 555-2671', 'US', '+14155552671');
    ok('1 415 555 2671', 'US', '+14155552671');
  });

  it('is case-insensitive about the country and never assumes one', () => {
    ok('03001234567', 'pk', '+923001234567');
    fails('03001234567', null, 'NEEDS_COUNTRY_CODE');
    fails('03001234567', 'ZZ', 'NEEDS_COUNTRY_CODE');
  });

  it('rejects what is not a phone number', () => {
    fails('', 'PK', 'EMPTY');
    fails('   ', 'PK', 'EMPTY');
    fails('call me', 'PK', 'INVALID');
    fails('0300-ABC4567', 'PK', 'INVALID');
    fails('++92 300 1234567', 'PK', 'INVALID');
    fails('92+3001234567', 'PK', 'INVALID');
    fails('---', 'PK', 'INVALID');
  });

  it('checks the length of the national number', () => {
    fails('0300 12345', 'PK', 'TOO_SHORT');
    fails('0300 123456789', 'PK', 'TOO_LONG');
    fails('+92 300 12345', 'PK', 'TOO_SHORT');
    fails('+1234567', null, 'TOO_SHORT');
    fails('+9230012345678901', null, 'TOO_LONG');
  });

  it('an unknown country code is accepted when the length is plausible', () => {
    ok('+999 12345678', null, '+99912345678');
  });

  it('only returns valid E.164', () => {
    for (const typed of ['0300 1234567', '+44 7911 123456', '(415) 555-2671']) {
      const result = normalizePhone(typed, typed.startsWith('(') ? 'US' : 'PK');
      expect(result.ok && isE164(result.e164)).toBe(true);
    }
    expect(isE164('+0123456789')).toBe(false);
    expect(isE164('923001234567')).toBe(false);
  });
});

describe('phoneSearchDigits', () => {
  it('gives the digits to look for, with and without the trunk zero', () => {
    expect(phoneSearchDigits('0300-123')).toEqual(['0300123', '300123']);
    expect(phoneSearchDigits('+92 300')).toEqual(['92300']);
  });

  it('is empty for words and for fragments that are too short', () => {
    expect(phoneSearchDigits('ali')).toEqual([]);
    expect(phoneSearchDigits('03')).toEqual([]);
    expect(phoneSearchDigits('ali 0300')).toEqual([]);
  });
});
