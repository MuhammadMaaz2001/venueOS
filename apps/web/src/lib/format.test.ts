import { describe, expect, it } from 'vitest';
import { formatDate, formatDateOnly, formatDateTime, formatMoney, formatTime } from './format';

// Intl puts a no-break space between the currency code and the number, and may add direction marks.
const SPACES = new RegExp('[\u00a0\u202f]', 'g');
const MARKS = new RegExp('[\u200e\u200f\u061c]', 'g');
const plain = (text: string) => text.replace(SPACES, ' ').replace(MARKS, '');

describe('formatMoney', () => {
  it('uses the currency minor units, not the locale: PKR 2, KWD 3, JPY 0', () => {
    expect(plain(formatMoney('125000.00', 'PKR', 'en'))).toBe('PKR 125,000.00');
    expect(plain(formatMoney('12.5', 'KWD', 'en'))).toBe('KWD 12.500');
    expect(plain(formatMoney('5000', 'JPY', 'en'))).toBe('JPY 5,000');
  });

  it('shows Latin digits in Urdu too', () => {
    const text = plain(formatMoney('1234567.50', 'PKR', 'ur'));
    expect(text).toMatch(/1,234,567\.50/);
    expect(text).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('keeps every digit of a long decimal string (no float round trip)', () => {
    expect(plain(formatMoney('9007199254740993.10', 'PKR', 'en'))).toBe(
      'PKR 9,007,199,254,740,993.10',
    );
  });

  it('rounds half-up to the minor unit and rejects garbage and unknown currencies', () => {
    expect(plain(formatMoney('0.005', 'PKR', 'en'))).toBe('PKR 0.01');
    expect(() => formatMoney('abc', 'PKR', 'en')).toThrow();
    expect(() => formatMoney('1', 'XXX', 'en')).toThrow();
  });
});

describe('dates in an explicit time zone', () => {
  const instant = '2027-02-14T20:30:00Z';

  it('rolls over to the next day in a zone ahead of UTC (Asia/Karachi is +05:00)', () => {
    expect(formatDate(instant, { locale: 'en', timeZone: 'Asia/Karachi' })).toBe('15 Feb 2027');
    expect(formatDate(instant, { locale: 'en', timeZone: 'UTC' })).toBe('14 Feb 2027');
  });

  it('shows the time and date-time of that zone, 24-hour, Latin digits', () => {
    expect(formatTime(instant, { locale: 'en', timeZone: 'Asia/Karachi' })).toBe('01:30');
    expect(plain(formatDateTime(instant, { locale: 'en', timeZone: 'Asia/Karachi' }))).toMatch(
      /15 Feb 2027.*01:30/,
    );
    expect(formatTime(instant, { locale: 'ur', timeZone: 'Asia/Karachi' })).toMatch(/^[0-9:]+$/);
  });

  it('never shifts a date-only value', () => {
    expect(formatDateOnly('2027-02-14', 'en')).toBe('14 Feb 2027');
    expect(() => formatDateOnly('14/02/2027', 'en')).toThrow(RangeError);
  });

  it('rejects an invalid instant', () => {
    expect(() => formatDate('not a date', { locale: 'en', timeZone: 'UTC' })).toThrow(RangeError);
  });
});
