import { describe, expect, it } from 'vitest';
import { MoneyError, formatMoney, money, parseMoney, roundMoney, sumMoney } from './money.js';

describe('money()', () => {
  it('accepts decimal strings and rejects JS numbers', () => {
    expect(money('10.50').toString()).toBe('10.5');
    // @ts-expect-error numbers are not allowed by the type either
    expect(() => money(10.5)).toThrow(MoneyError);
    expect(() => money('abc')).toThrow(MoneyError);
  });
});

describe('roundMoney (half-up to the currency minor unit)', () => {
  it('rounds PKR to 2 decimals, ties up', () => {
    expect(roundMoney('2.345', 'PKR').toString()).toBe('2.35');
    expect(roundMoney('2.344', 'PKR').toString()).toBe('2.34');
    expect(roundMoney('2.3449999', 'PKR').toString()).toBe('2.34');
  });

  it('rounds KWD to 3 and JPY to 0 decimals', () => {
    expect(roundMoney('1.2345', 'KWD').toString()).toBe('1.235');
    expect(roundMoney('1234.5', 'JPY').toString()).toBe('1235');
    expect(roundMoney('1234.4', 'JPY').toString()).toBe('1234');
  });

  it('ties go away from zero for negative amounts (symmetric with positive)', () => {
    expect(roundMoney('-2.345', 'PKR').toString()).toBe('-2.35');
  });

  it('rejects unknown currencies', () => {
    expect(() => roundMoney('1', 'XXX')).toThrow();
  });
});

describe('formatMoney', () => {
  it('always uses exactly the currency decimals', () => {
    expect(formatMoney('1500', 'PKR')).toBe('1500.00');
    expect(formatMoney('12.5', 'KWD')).toBe('12.500');
    expect(formatMoney('899.6', 'JPY')).toBe('900');
    expect(formatMoney('0', 'PKR')).toBe('0.00');
    expect(formatMoney('-100', 'PKR')).toBe('-100.00');
  });

  it('is exact for values floats get wrong', () => {
    expect(formatMoney(money('0.1').plus('0.2'), 'PKR')).toBe('0.30');
    expect(formatMoney('1.005', 'PKR')).toBe('1.01'); // 1.005 * 100 === 100.49999 in floats
  });
});

describe('parseMoney (client input)', () => {
  it('accepts plain decimals within the currency precision', () => {
    expect(parseMoney('1500', 'PKR').toString()).toBe('1500');
    expect(parseMoney('1500.50', 'PKR').toString()).toBe('1500.5');
    expect(parseMoney('12.345', 'KWD').toString()).toBe('12.345');
    expect(parseMoney('-250.00', 'PKR').toString()).toBe('-250');
  });

  it('rejects extra decimals, junk and exponent notation instead of rounding', () => {
    expect(() => parseMoney('10.005', 'PKR')).toThrow(/at most 2 decimals/);
    expect(() => parseMoney('10.5', 'JPY')).toThrow(/at most 0 decimals/);
    for (const bad of ['', '1e3', '1,000', ' 5', '5 ', '.5', '5.', 'NaN', 'Infinity', '--5']) {
      expect(() => parseMoney(bad, 'PKR'), JSON.stringify(bad)).toThrow(MoneyError);
    }
  });
});

describe('sumMoney', () => {
  it('adds exactly', () => {
    expect(sumMoney(['0.1', '0.2', money('0.3')]).toString()).toBe('0.6');
    expect(sumMoney([]).toString()).toBe('0');
  });

  it('sum of rounded lines can differ from the rounded sum (rounding is per line)', () => {
    const lines = ['1.004', '1.004', '1.004'].map((l) => roundMoney(l, 'PKR'));
    expect(sumMoney(lines).toString()).toBe('3');
    expect(formatMoney(sumMoney(['1.004', '1.004', '1.004']), 'PKR')).toBe('3.01');
  });
});
