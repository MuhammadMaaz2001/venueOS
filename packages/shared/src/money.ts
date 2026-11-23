import { Decimal } from 'decimal.js';
import { minorUnits } from './currency.js';

/**
 * Money helpers (CLAUDE.md rule 4): amounts are decimal.js values in code and strings on the wire,
 * never JS numbers. Rounding happens once, at line level, to the currency's ISO 4217 minor unit,
 * half-up (docs/05-business-rules.md §3: ties go away from zero). The database column is
 * Decimal(18,3); the extra digit exists only so 3-decimal currencies fit.
 */

// A private Decimal constructor: our rounding/precision settings never leak into (or from) other
// code that configures the global decimal.js.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Money = Decimal;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export type MoneyInput = Decimal | string;

/** Convert to a Decimal. JS numbers are rejected on purpose: they cannot hold money exactly. */
export function money(value: MoneyInput): Money {
  if (typeof value !== 'string' && !Decimal.isDecimal(value)) {
    throw new MoneyError('Money must be a decimal string or Decimal, never a number');
  }
  try {
    return new D(value);
  } catch {
    throw new MoneyError(`Not a decimal amount: ${JSON.stringify(String(value))}`);
  }
}

/** Round half-up to the currency's minor unit. Call this on each line, not on totals. */
export function roundMoney(value: MoneyInput, currency: string): Money {
  return money(value).toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);
}

/** API/storage form: a string with exactly the currency's decimals ("1500.00" PKR, "12.500" KWD, "900" JPY). */
export function formatMoney(value: MoneyInput, currency: string): string {
  return roundMoney(value, currency).toFixed(minorUnits(currency));
}

const MONEY_STRING = /^-?\d{1,15}(\.\d+)?$/;

/**
 * Parse an amount that arrived from a client or the API. Strict: plain decimal notation only, and no
 * more decimals than the currency has (so "10.005" PKR is an error, never silently rounded).
 */
export function parseMoney(text: string, currency: string): Money {
  const decimals = minorUnits(currency);
  if (typeof text !== 'string' || !MONEY_STRING.test(text)) {
    throw new MoneyError(`Not a valid money string: ${JSON.stringify(text)}`);
  }
  const fraction = text.split('.')[1]?.length ?? 0;
  if (fraction > decimals) {
    throw new MoneyError(`${currency} allows at most ${decimals} decimals, got ${fraction}`);
  }
  return money(text);
}

/** Sum of lines that are already rounded. */
export function sumMoney(values: readonly MoneyInput[]): Money {
  return values.reduce<Money>((total, v) => total.plus(money(v)), new D(0));
}
