import { CURRENCY_MINOR_UNITS } from '@venueos/shared';

/**
 * Convenience defaults for the signup form only: picking a country pre-fills the usual currency and time zone,
 * which the user can still change. Nothing else in the app reads this table, and a country without an entry
 * simply leaves the two fields as they are.
 */
export const COUNTRY_DEFAULTS: Readonly<Record<string, { currency: string; timezone: string }>> = {
  PK: { currency: 'PKR', timezone: 'Asia/Karachi' },
  AE: { currency: 'AED', timezone: 'Asia/Dubai' },
  SA: { currency: 'SAR', timezone: 'Asia/Riyadh' },
  QA: { currency: 'QAR', timezone: 'Asia/Qatar' },
  KW: { currency: 'KWD', timezone: 'Asia/Kuwait' },
  BH: { currency: 'BHD', timezone: 'Asia/Bahrain' },
  OM: { currency: 'OMR', timezone: 'Asia/Muscat' },
  IN: { currency: 'INR', timezone: 'Asia/Kolkata' },
  BD: { currency: 'BDT', timezone: 'Asia/Dhaka' },
  GB: { currency: 'GBP', timezone: 'Europe/London' },
  US: { currency: 'USD', timezone: 'America/New_York' },
};

/** Countries offered at signup (ISO 3166-1 alpha-2). The display names come from `Intl.DisplayNames`. */
export const COUNTRY_CODES: readonly string[] = [
  'PK',
  'AE',
  'SA',
  'QA',
  'KW',
  'BH',
  'OM',
  'IN',
  'BD',
  'LK',
  'NP',
  'AF',
  'IR',
  'IQ',
  'JO',
  'LB',
  'EG',
  'TR',
  'MA',
  'DZ',
  'TN',
  'MY',
  'SG',
  'ID',
  'GB',
  'IE',
  'US',
  'CA',
  'AU',
  'NZ',
  'DE',
  'FR',
  'NL',
  'ZA',
  'KE',
  'NG',
];

/** Time zones shown before the browser's full list is read (identical on the server and the first render). */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Qatar',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Europe/London',
  'America/New_York',
  'UTC',
];

export const CURRENCY_CODES: readonly string[] = Object.keys(CURRENCY_MINOR_UNITS).sort();
