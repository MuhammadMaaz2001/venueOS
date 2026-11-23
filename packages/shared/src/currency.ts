import { z } from 'zod';

/**
 * ISO 4217 minor units (number of decimals) for every active currency code. Rounding, money strings
 * and display all use this map: PKR 2, KWD 3, JPY 0 (CLAUDE.md rule 4). Nothing else in the code
 * may assume a currency's precision, and an unknown code is an error, never "assume 2".
 */
const BY_DECIMALS = {
  0: 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF',
  2:
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CNY COP CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD ' +
    'GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD ' +
    'MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP ' +
    'PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS ' +
    'TMT TOP TRY TTD TWD TZS UAH USD UYU UZS VES WST XCD YER ZAR ZMW ZWG',
  3: 'BHD IQD JOD KWD LYD OMR TND',
  4: 'CLF UYW',
} as const;

export type MinorUnits = 0 | 1 | 2 | 3 | 4;

export const CURRENCY_MINOR_UNITS: Readonly<Record<string, MinorUnits>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(BY_DECIMALS) as [string, string][]).flatMap(([digits, codes]) =>
      codes.split(' ').map((code) => [code, Number(digits) as MinorUnits] as const),
    ),
  ),
);

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`Unsupported currency code: ${JSON.stringify(code)}`);
    this.name = 'UnknownCurrencyError';
  }
}

export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(CURRENCY_MINOR_UNITS, code);
}

/** Number of decimals of a currency's minor unit. Throws for codes that are not ISO 4217 (upper case). */
export function minorUnits(code: string): MinorUnits {
  if (!isSupportedCurrency(code)) throw new UnknownCurrencyError(code);
  return CURRENCY_MINOR_UNITS[code] as MinorUnits;
}

/** Zod schema for a currency code (tenants.currency, bookings.currency). */
export const currencyCodeSchema = z
  .string()
  .refine(isSupportedCurrency, { message: 'Unsupported currency code' });
