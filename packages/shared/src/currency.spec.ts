import { describe, expect, it } from 'vitest';
import {
  CURRENCY_MINOR_UNITS,
  UnknownCurrencyError,
  currencyCodeSchema,
  isSupportedCurrency,
  minorUnits,
} from './currency.js';

describe('minorUnits (ISO 4217)', () => {
  it.each([
    ['PKR', 2],
    ['USD', 2],
    ['AED', 2],
    ['KWD', 3],
    ['BHD', 3],
    ['OMR', 3],
    ['JPY', 0],
    ['KRW', 0],
    ['CLF', 4],
  ])('%s has %i decimals', (code, decimals) => {
    expect(minorUnits(code)).toBe(decimals);
  });

  it('throws for unknown or badly cased codes instead of assuming 2', () => {
    for (const bad of ['XXX', 'pkr', 'PK', '', 'toString', '__proto__']) {
      expect(() => minorUnits(bad)).toThrow(UnknownCurrencyError);
    }
  });

  it('has no duplicate codes and only three-letter upper-case keys', () => {
    for (const code of Object.keys(CURRENCY_MINOR_UNITS)) expect(code).toMatch(/^[A-Z]{3}$/);
    expect(Object.keys(CURRENCY_MINOR_UNITS).length).toBeGreaterThan(150);
  });

  it('isSupportedCurrency and the Zod schema agree', () => {
    expect(isSupportedCurrency('PKR')).toBe(true);
    expect(isSupportedCurrency(42)).toBe(false);
    expect(currencyCodeSchema.safeParse('KWD').success).toBe(true);
    expect(currencyCodeSchema.safeParse('ZZZ').success).toBe(false);
  });
});
