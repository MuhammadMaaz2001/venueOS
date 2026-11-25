import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../common/errors/domain-errors';
import {
  durationMinutes,
  fitsOpeningHours,
  resolveSlotTimes,
} from '../modules/slot-templates/slot-times';

const noHours = { opensAt: null, closesAt: null };

describe('durationMinutes', () => {
  it('measures a same-day range, an overnight range and a full day', () => {
    expect(durationMinutes('12:00', '16:00')).toBe(240);
    expect(durationMinutes('19:00', '23:30')).toBe(270);
    expect(durationMinutes('22:00', '02:00')).toBe(240);
    expect(durationMinutes('00:00', '00:00')).toBe(1440);
  });
});

describe('fitsOpeningHours', () => {
  it('same-day opening hours', () => {
    expect(fitsOpeningHours('10:00', '12:00', '10:00', '23:00')).toBe(true);
    expect(fitsOpeningHours('09:00', '12:00', '10:00', '23:00')).toBe(false);
    expect(fitsOpeningHours('21:00', '23:30', '10:00', '23:00')).toBe(false);
  });

  it('opening hours that close after midnight', () => {
    expect(fitsOpeningHours('20:00', '01:00', '10:00', '02:00')).toBe(true);
    expect(fitsOpeningHours('01:00', '03:00', '10:00', '02:00')).toBe(false);
    expect(fitsOpeningHours('03:00', '05:00', '10:00', '02:00')).toBe(false);
  });
});

describe('resolveSlotTimes', () => {
  it('FIXED keeps the given times (an end before the start is next day) and needs both', () => {
    expect(
      resolveSlotTimes({ mode: 'FIXED', startTime: '22:00', endTime: '02:00' }, noHours),
    ).toEqual({ startTime: '22:00', endTime: '02:00' });
    expect(() => resolveSlotTimes({ mode: 'FIXED', startTime: '22:00' }, noHours)).toThrow(
      FieldValidationError,
    );
    expect(() =>
      resolveSlotTimes({ mode: 'FIXED', startTime: '10:00', endTime: '10:00' }, noHours),
    ).toThrow(FieldValidationError);
  });

  it('FULL_DAY is stored as 00:00-00:00 whatever the venue hours', () => {
    expect(resolveSlotTimes({ mode: 'FULL_DAY' }, { opensAt: '10:00', closesAt: '23:00' })).toEqual(
      { startTime: '00:00', endTime: '00:00' },
    );
  });

  it('HOURLY defaults to the venue hours, or to the whole day without any', () => {
    expect(resolveSlotTimes({ mode: 'HOURLY' }, { opensAt: '10:00', closesAt: '02:00' })).toEqual({
      startTime: '10:00',
      endTime: '02:00',
    });
    expect(resolveSlotTimes({ mode: 'HOURLY' }, noHours)).toEqual({
      startTime: '00:00',
      endTime: '00:00',
    });
  });

  it('HOURLY must fit the venue hours and the minimum', () => {
    const hours = { opensAt: '10:00', closesAt: '23:00' };
    expect(() =>
      resolveSlotTimes({ mode: 'HOURLY', startTime: '08:00', endTime: '12:00' }, hours),
    ).toThrow(FieldValidationError);
    expect(() =>
      resolveSlotTimes(
        { mode: 'HOURLY', startTime: '10:00', endTime: '12:00', minHours: 3 },
        hours,
      ),
    ).toThrow(FieldValidationError);
    expect(
      resolveSlotTimes(
        { mode: 'HOURLY', startTime: '10:00', endTime: '13:00', minHours: 3 },
        hours,
      ),
    ).toEqual({ startTime: '10:00', endTime: '13:00' });
  });
});
