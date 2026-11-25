import { describe, expect, it } from 'vitest';
import { maskEmail, maskSensitiveValue } from './mask.js';

describe('maskSensitiveValue', () => {
  it('masks a CNIC like the example of docs/04', () => {
    expect(maskSensitiveValue('12345-1234567-1')).toBe('*****-*****67-1');
  });

  it('keeps separators and the last characters only', () => {
    expect(maskSensitiveValue('1234567890123')).toBe('*********0123');
    expect(maskSensitiveValue('AB-123456')).toBe('**-***456');
  });

  it('shows (almost) nothing of a short value', () => {
    expect(maskSensitiveValue('12')).toBe('**');
    expect(maskSensitiveValue('abcd')).toBe('***d');
    expect(maskSensitiveValue('')).toBe('');
  });

  it('never returns the clear value for anything of 3 characters or more', () => {
    for (const value of ['abc', '4220112345671', '+92 300 1234567', 'passport A1234567']) {
      expect(maskSensitiveValue(value)).not.toBe(value);
    }
  });
});

describe('maskEmail', () => {
  it('keeps the domain only', () => {
    expect(maskEmail('ali.khan@example.com')).toBe('a***@example.com');
    expect(maskEmail('nonsense')).toBe('***');
  });
});
