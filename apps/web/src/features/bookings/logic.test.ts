import { describe, expect, it } from 'vitest';
import {
  cellKey,
  datesBetween,
  holdTimer,
  indexCells,
  joinDistinct,
  monthRange,
  offeredActions,
  shiftDate,
  shiftMonth,
  slotOffered,
  subtract,
  startOfWeek,
  statusTone,
  viewRange,
  weekRange,
  weekdayOf,
} from './logic';

describe('date arithmetic', () => {
  it('shifts across month and year ends without a zone', () => {
    expect(shiftDate('2031-01-31', 1)).toBe('2031-02-01');
    expect(shiftDate('2030-12-31', 1)).toBe('2031-01-01');
    expect(shiftDate('2031-03-01', -1)).toBe('2031-02-28');
    expect(shiftDate('2032-03-01', -1)).toBe('2032-02-29');
  });
  it('knows the weekday (0 = Sunday) and the Monday of a week', () => {
    expect(weekdayOf('2031-01-01')).toBe(3); // Wednesday
    expect(startOfWeek('2031-01-01')).toBe('2030-12-30');
    expect(startOfWeek('2031-01-05')).toBe('2030-12-30'); // Sunday belongs to the week that began on Monday
    expect(startOfWeek('2031-01-06')).toBe('2031-01-06');
  });
  it('gives month and week ranges', () => {
    expect(monthRange('2031-02-14')).toEqual({ from: '2031-02-01', to: '2031-02-28' });
    expect(monthRange('2032-02-14')).toEqual({ from: '2032-02-01', to: '2032-02-29' });
    expect(weekRange('2031-01-01')).toEqual({ from: '2030-12-30', to: '2031-01-05' });
    expect(viewRange('month', '2031-06-10')).toEqual({ from: '2031-06-01', to: '2031-06-30' });
    expect(viewRange('week', '2031-06-10')).toEqual({ from: '2031-06-09', to: '2031-06-15' });
    expect(shiftMonth('2031-01-31', 1)).toBe('2031-02-01');
    expect(shiftMonth('2031-01-15', -1)).toBe('2030-12-01');
  });
  it('lists the days between two dates, inclusive', () => {
    expect(datesBetween('2031-02-27', '2031-03-02')).toEqual([
      '2031-02-27',
      '2031-02-28',
      '2031-03-01',
      '2031-03-02',
    ]);
    expect(datesBetween('2031-02-02', '2031-02-01')).toEqual([]);
  });
  it('refuses a malformed date', () => {
    expect(() => shiftDate('01/02/2031', 1)).toThrow(RangeError);
  });
});

describe('calendar cells', () => {
  it('indexes taken cells; the rest of the grid is free', () => {
    const cell = {
      spaceId: 's',
      date: '2031-01-01',
      slotId: 'l',
      status: 'HELD' as const,
      entries: [],
    };
    const index = indexCells([cell]);
    expect(index.get(cellKey('s', '2031-01-01', 'l'))).toBe(cell);
    expect(index.get(cellKey('s', '2031-01-02', 'l'))).toBeUndefined();
  });
  it('offers a slot on its weekdays only (empty = every day)', () => {
    expect(slotOffered({ daysOfWeek: [] }, '2031-01-01')).toBe(true);
    expect(slotOffered({ daysOfWeek: [3] }, '2031-01-01')).toBe(true);
    expect(slotOffered({ daysOfWeek: [0, 6] }, '2031-01-01')).toBe(false);
  });
});

describe('hold timer', () => {
  const now = new Date('2031-01-01T10:00:00Z');
  it('counts hours and minutes down', () => {
    expect(holdTimer('2031-01-03T11:30:45Z', now)).toEqual({
      expired: false,
      hours: 49,
      minutes: 30,
    });
    expect(holdTimer('2031-01-01T10:05:00Z', now)).toEqual({
      expired: false,
      hours: 0,
      minutes: 5,
    });
  });
  it('is expired at or after the end', () => {
    expect(holdTimer('2031-01-01T10:00:00Z', now).expired).toBe(true);
    expect(holdTimer('2031-01-01T09:00:00Z', now)).toEqual({ expired: true, hours: 0, minutes: 0 });
  });
});

describe('what a booking can do', () => {
  it('follows the state machine', () => {
    expect(offeredActions('DRAFT')).toEqual(['hold', 'cancel']);
    expect(offeredActions('TENTATIVE')).toEqual(['extend-hold', 'confirm', 'cancel']);
    expect(offeredActions('CONFIRMED')).toEqual(['cancel']);
    expect(offeredActions('CANCELLED')).toEqual(['restore']);
    expect(offeredActions('EXPIRED')).toEqual(['rehold']);
    expect(offeredActions('COMPLETED')).toEqual([]);
  });
  it('tones', () => {
    expect(statusTone('TENTATIVE')).toBe('warning');
    expect(statusTone('CONFIRMED')).toBe('success');
    expect(statusTone('EXPIRED')).toBe('danger');
    expect(statusTone('DRAFT')).toBe('muted');
  });
  it('joins distinct names', () => {
    expect(joinDistinct(['Mehndi', null, 'Barat', 'Mehndi', ''])).toBe('Mehndi, Barat');
  });
});

describe('subtract (money strings, exact)', () => {
  it('works in integer arithmetic with the currency decimals', () => {
    expect(subtract('116000.00', '50000.00')).toBe('66000.00');
    expect(subtract('0.30', '0.10')).toBe('0.20');
    expect(subtract('100.000', '100.001')).toBe('-0.001');
    expect(subtract('5000', '5000')).toBe('0');
    expect(subtract('12.500', '0.5')).toBe('12.000');
    expect(subtract('99999999999999999.99', '0.01')).toBe('99999999999999999.98');
  });
});
