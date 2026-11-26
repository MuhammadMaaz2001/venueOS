import { formatMoney as toMoneyString, minorUnits } from '@venueos/shared';

/**
 * The only place the web app formats money and dates (apps/web/CLAUDE.md).
 *
 * - Money: an API money string with the currency's own decimals ("125000.00" PKR, "12.500" KWD, "5000" JPY) is
 *   grouped for display WITHOUT going through a JS number, so no digit is ever lost. Decimals come from the
 *   ISO 4217 minor-unit map in `@venueos/shared`, never from the locale.
 * - Dates: an instant (ISO 8601 UTC) is shown in an explicit IANA time zone (the venue's, or the tenant's until
 *   venues exist), never in the browser's or the server's. A date-only value (`YYYY-MM-DD`) has no zone and is
 *   never shifted.
 * - Digits are Latin (0-9) in every language (also Arabic, planned), so amounts and dates always read the same.
 */

/**
 * Regional variant used for `Intl`: day-month-year and 24-hour time for English (the markets of venueOS write
 * dates that way). Another language is used as it is, or gets its own entry here when it is added.
 */
const REGIONAL: Readonly<Record<string, string>> = { en: 'en-GB' };

/** BCP 47 tag for `Intl`, with Latin digits and the Gregorian calendar forced. */
function intlLocale(locale: string): string {
  return `${REGIONAL[locale] ?? locale}-u-nu-latn-ca-gregory`;
}

/** A money value for display, e.g. `PKR 125,000.00`, `KWD 12.500`, `JPY 5,000`. */
export function formatMoney(value: string, currency: string, locale: string): string {
  const decimals = minorUnits(currency);
  // Normalises to exactly `decimals` places (half-up) and validates the string; throws on garbage.
  const canonical = toMoneyString(value, currency);
  const formatter = new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  // Intl formats a decimal STRING exactly (no float round trip).
  return formatter.format(canonical as Intl.StringNumericLiteral);
}

export interface DateFormatOptions {
  locale: string;
  /** IANA zone, e.g. `Asia/Karachi`. Required: there is no implicit zone. */
  timeZone: string;
}

function toDate(instant: string | Date): Date {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(instant)}`);
  return date;
}

/** `14 Feb 2027` of an instant, in the given zone. */
export function formatDate(
  instant: string | Date,
  { locale, timeZone }: DateFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toDate(instant));
}

/** `19:00` (24-hour) of an instant, in the given zone. */
export function formatTime(
  instant: string | Date,
  { locale, timeZone }: DateFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(toDate(instant));
}

/** `14 Feb 2027, 19:00` of an instant, in the given zone. */
export function formatDateTime(
  instant: string | Date,
  { locale, timeZone }: DateFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(toDate(instant));
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateOnlyStyle = 'medium' | 'short' | 'long';

/**
 * `14 Feb 2027` of a date-only value (`2027-02-14`). It has no zone, so it is never shifted. `short` is `Sun 14` (a calendar
 * column), `long` is `Sunday, 14 February 2027`.
 */
export function formatDateOnly(
  value: string,
  locale: string,
  style: DateOnlyStyle = 'medium',
): string {
  const match = DATE_ONLY.exec(value);
  if (!match) throw new RangeError(`Invalid date-only value: ${value}`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const options: Intl.DateTimeFormatOptions =
    style === 'short'
      ? { weekday: 'short', day: 'numeric' }
      : style === 'long'
        ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', ...options }).format(date);
}
