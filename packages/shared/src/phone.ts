// Phone numbers (docs/05 section 12): stored in E.164 (`+923001234567`) so WhatsApp links and duplicate detection work,
// normalised with the tenant's country (ISO 3166-1 alpha-2). No library: this is the one place the rules live, and
// it must not assume a country (CLAUDE.md). A number typed with its country code (`+92 ...`, `0092 ...`) never needs the
// tenant's country; a national number (`0300 1234567`) does.

interface CountryPhoneRule {
  /** Country calling code without the plus. */
  code: string;
  /** The national number starts with this trunk digit when dialled inside the country, and it is dropped (`0`). */
  trunk: '0' | '';
  /** Length of the national significant number (without the trunk digit), inclusive bounds. */
  min: number;
  max: number;
}

const rule = (code: string, trunk: '0' | '', min: number, max: number): CountryPhoneRule => ({
  code,
  trunk,
  min,
  max,
});

/** Calling codes and national number lengths of the markets venueOS is built for, and the common neighbours. */
const COUNTRY_RULES: Readonly<Record<string, CountryPhoneRule>> = {
  PK: rule('92', '0', 9, 10),
  IN: rule('91', '0', 10, 10),
  BD: rule('880', '0', 8, 10),
  LK: rule('94', '0', 9, 9),
  NP: rule('977', '0', 8, 10),
  AF: rule('93', '0', 9, 9),
  MV: rule('960', '', 7, 7),
  AE: rule('971', '0', 8, 9),
  SA: rule('966', '0', 8, 9),
  QA: rule('974', '', 8, 8),
  KW: rule('965', '', 8, 8),
  BH: rule('973', '', 8, 8),
  OM: rule('968', '', 8, 8),
  JO: rule('962', '0', 8, 9),
  LB: rule('961', '0', 7, 8),
  SY: rule('963', '0', 8, 9),
  IQ: rule('964', '0', 9, 10),
  IR: rule('98', '0', 10, 10),
  YE: rule('967', '0', 7, 9),
  TR: rule('90', '0', 10, 10),
  EG: rule('20', '0', 9, 10),
  MA: rule('212', '0', 9, 9),
  DZ: rule('213', '0', 9, 9),
  TN: rule('216', '', 8, 8),
  LY: rule('218', '0', 9, 10),
  SD: rule('249', '0', 9, 9),
  ET: rule('251', '0', 9, 9),
  KE: rule('254', '0', 9, 9),
  TZ: rule('255', '0', 9, 9),
  UG: rule('256', '0', 9, 9),
  GH: rule('233', '0', 9, 9),
  NG: rule('234', '0', 7, 10),
  ZA: rule('27', '0', 9, 9),
  GB: rule('44', '0', 9, 10),
  IE: rule('353', '0', 7, 9),
  DE: rule('49', '0', 6, 13),
  FR: rule('33', '0', 9, 9),
  ES: rule('34', '', 9, 9),
  IT: rule('39', '', 6, 11),
  NL: rule('31', '0', 9, 9),
  BE: rule('32', '0', 8, 9),
  CH: rule('41', '0', 9, 9),
  SE: rule('46', '0', 7, 9),
  NO: rule('47', '', 8, 8),
  DK: rule('45', '', 8, 8),
  FI: rule('358', '0', 5, 10),
  PL: rule('48', '', 9, 9),
  UA: rule('380', '0', 9, 9),
  AZ: rule('994', '0', 9, 9),
  UZ: rule('998', '', 9, 9),
  KZ: rule('7', '', 10, 10),
  RU: rule('7', '', 10, 10),
  US: rule('1', '', 10, 10),
  CA: rule('1', '', 10, 10),
  MX: rule('52', '', 10, 10),
  BR: rule('55', '0', 10, 11),
  AR: rule('54', '0', 10, 11),
  CL: rule('56', '', 9, 9),
  CO: rule('57', '', 10, 10),
  PE: rule('51', '0', 8, 9),
  AU: rule('61', '0', 9, 9),
  NZ: rule('64', '0', 8, 10),
  CN: rule('86', '0', 9, 11),
  HK: rule('852', '', 8, 8),
  JP: rule('81', '0', 9, 10),
  KR: rule('82', '0', 8, 10),
  SG: rule('65', '', 8, 8),
  MY: rule('60', '0', 9, 10),
  ID: rule('62', '0', 8, 12),
  TH: rule('66', '0', 8, 9),
  PH: rule('63', '0', 9, 10),
  VN: rule('84', '0', 9, 10),
  MM: rule('95', '0', 8, 10),
};

const CODES_LONGEST_FIRST: readonly string[] = [
  ...new Set(Object.values(COUNTRY_RULES).map((r) => r.code)),
].sort((a, b) => b.length - a.length);

export type PhoneFailure = 'EMPTY' | 'INVALID' | 'NEEDS_COUNTRY_CODE' | 'TOO_SHORT' | 'TOO_LONG';

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: PhoneFailure };

/** E.164: a plus, a first digit 1-9 and at most 15 digits in all (at least 8 here: no real number is shorter). */
const E164 = /^\+[1-9]\d{7,14}$/;
export const isE164 = (value: string): boolean => E164.test(value);

/** The words a form shows for a failure (the API sends the same text). */
export const PHONE_FAILURE_MESSAGES: Readonly<Record<PhoneFailure, string>> = {
  EMPTY: 'Enter a phone number',
  INVALID: 'Enter a valid phone number',
  NEEDS_COUNTRY_CODE: 'Start the number with the country code, e.g. +92',
  TOO_SHORT: 'This phone number is too short',
  TOO_LONG: 'This phone number is too long',
};

/**
 * Normalise what a person typed into E.164. `country` is the workspace's country (ISO alpha-2): it only matters for a
 * number typed the national way (`0300 1234567`). Spaces, dashes, dots, slashes and brackets are ignored; letters are not
 * allowed. Never throws.
 */
export function normalizePhone(input: string, country: string | null | undefined): PhoneResult {
  const raw = input.trim();
  if (raw === '') return { ok: false, reason: 'EMPTY' };
  if (!/^\+?[\d\s().\-/]+$/.test(raw) || (raw.includes('+') && !raw.startsWith('+'))) {
    return { ok: false, reason: 'INVALID' };
  }
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return { ok: false, reason: 'INVALID' };

  // Typed with a country code: `+92 ...` or the international prefix `0092 ...`.
  if (raw.startsWith('+') || digits.startsWith('00')) {
    const international = raw.startsWith('+') ? digits : digits.slice(2);
    return finishInternational(international);
  }

  const rules = country ? COUNTRY_RULES[country.toUpperCase()] : undefined;
  if (!rules) return { ok: false, reason: 'NEEDS_COUNTRY_CODE' };

  let national = digits;
  const bare = national.length >= rules.min && national.length <= rules.max && national[0] !== '0';
  if (!bare) {
    if (rules.trunk && national.startsWith(rules.trunk)) {
      national = national.slice(rules.trunk.length);
    } else if (rules.code === '1' && national.length === 11 && national.startsWith('1')) {
      national = national.slice(1);
    } else if (
      national.startsWith(rules.code) &&
      national.length - rules.code.length >= rules.min &&
      national.length - rules.code.length <= rules.max
    ) {
      // `923001234567`: the country code without the plus.
      return finishInternational(national);
    }
  }
  if (national.length < rules.min) return { ok: false, reason: 'TOO_SHORT' };
  if (national.length > rules.max) return { ok: false, reason: 'TOO_LONG' };
  if (national.startsWith('0')) return { ok: false, reason: 'INVALID' };
  return finishInternational(`${rules.code}${national}`);
}

function finishInternational(digits: string): PhoneResult {
  if (digits.startsWith('0')) return { ok: false, reason: 'INVALID' };
  if (digits.length < 8) return { ok: false, reason: 'TOO_SHORT' };
  if (digits.length > 15) return { ok: false, reason: 'TOO_LONG' };
  // A known country code also fixes the length of the rest; an unknown one is accepted as long as it is plausible.
  const code = CODES_LONGEST_FIRST.find((c) => digits.startsWith(c));
  if (code) {
    const lengths = Object.values(COUNTRY_RULES).filter((r) => r.code === code);
    const rest = digits.length - code.length;
    const fits = lengths.some((r) => rest >= r.min && rest <= r.max);
    if (!fits) {
      const shortest = Math.min(...lengths.map((r) => r.min));
      return { ok: false, reason: rest < shortest ? 'TOO_SHORT' : 'TOO_LONG' };
    }
  }
  const e164 = `+${digits}`;
  return isE164(e164) ? { ok: true, e164 } : { ok: false, reason: 'INVALID' };
}

/** The digits of a search box entry (`0300-123`, `+92 300`), for matching stored E.164 numbers. */
export function phoneSearchDigits(input: string): string[] {
  if (!/^\+?[\d\s().\-/]+$/.test(input.trim())) return [];
  const digits = input.replace(/\D/g, '');
  if (digits.length < 3) return [];
  // `0300123` is also found as `300123` inside `+92300123...`.
  const withoutTrunk = digits.replace(/^0+/, '');
  return [...new Set([digits, withoutTrunk].filter((d) => d.length >= 3))];
}
