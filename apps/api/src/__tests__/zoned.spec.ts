import { describe, expect, it } from 'vitest';
import { parseDateOnly, startOfLocalDay, startOfNextLocalDay } from '../common/time/zoned';

describe('zoned calendar days', () => {
  it('starts a day at local midnight, east and west of Greenwich', () => {
    expect(startOfLocalDay('2027-02-14', 'Asia/Karachi').toISOString()).toBe(
      '2027-02-13T19:00:00.000Z',
    );
    expect(startOfLocalDay('2027-02-14', 'UTC').toISOString()).toBe('2027-02-14T00:00:00.000Z');
    expect(startOfLocalDay('2027-02-14', 'America/New_York').toISOString()).toBe(
      '2027-02-14T05:00:00.000Z',
    );
    expect(startOfLocalDay('2027-02-14', 'Asia/Kuwait').toISOString()).toBe(
      '2027-02-13T21:00:00.000Z',
    );
  });

  it('follows daylight saving time', () => {
    expect(startOfLocalDay('2027-07-01', 'America/New_York').toISOString()).toBe(
      '2027-07-01T04:00:00.000Z',
    );
    // The day of the spring change is 23 hours long.
    const start = startOfLocalDay('2027-03-14', 'America/New_York');
    const next = startOfNextLocalDay('2027-03-14', 'America/New_York');
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('the next day starts where the day ends, also over a month and a year end', () => {
    expect(startOfNextLocalDay('2027-12-31', 'UTC').toISOString()).toBe('2028-01-01T00:00:00.000Z');
    expect(startOfNextLocalDay('2028-02-28', 'UTC').toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('accepts only real calendar days', () => {
    expect(parseDateOnly('2027-02-14')).toEqual({ year: 2027, month: 2, day: 14 });
    expect(parseDateOnly('2027-02-30')).toBeNull();
    expect(parseDateOnly('2027-13-01')).toBeNull();
    expect(parseDateOnly('14/02/2027')).toBeNull();
    expect(() => startOfLocalDay('nope', 'UTC')).toThrow(RangeError);
  });
});
