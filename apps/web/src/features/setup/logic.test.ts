import { describe, expect, it } from 'vitest';
import type { SlotTemplateDto, SpaceDto, VenueDto } from '@venueos/shared';
import { SLOT_PRESETS, currentStep, describeDays, endsNextDay, wholeNumberOrNull } from './logic';

const venue = { id: 'v1' } as VenueDto;
const space = { id: 's1' } as SpaceDto;
const slot = { id: 'l1' } as SlotTemplateDto;

describe('currentStep', () => {
  it('walks venue → spaces → slots → prices → done from what exists', () => {
    expect(currentStep({ venue: undefined, spaces: [], slots: [], pricedSpaces: 0 }, false)).toBe(
      'venue',
    );
    expect(currentStep({ venue, spaces: [], slots: [], pricedSpaces: 0 }, false)).toBe('spaces');
    expect(currentStep({ venue, spaces: [space], slots: [], pricedSpaces: 0 }, false)).toBe(
      'slots',
    );
    expect(currentStep({ venue, spaces: [space], slots: [slot], pricedSpaces: 0 }, false)).toBe(
      'prices',
    );
    expect(currentStep({ venue, spaces: [space], slots: [slot], pricedSpaces: 1 }, true)).toBe(
      'done',
    );
  });

  it('never skips ahead of missing data, even when prices were marked done', () => {
    expect(currentStep({ venue, spaces: [space], slots: [], pricedSpaces: 0 }, true)).toBe('slots');
  });
});

describe('presets and helpers', () => {
  it('offers Lunch and Dinner as in the docs', () => {
    expect(SLOT_PRESETS.map((p) => [p.key, p.startTime, p.endTime])).toEqual([
      ['lunch', '12:00', '16:00'],
      ['dinner', '19:00', '23:30'],
    ]);
  });

  it('wholeNumberOrNull accepts digits only', () => {
    expect(wholeNumberOrNull('500')).toBe(500);
    expect(wholeNumberOrNull(' 12 ')).toBe(12);
    expect(wholeNumberOrNull('')).toBeNull();
    expect(wholeNumberOrNull('1e3')).toBeNull();
    expect(wholeNumberOrNull('-5')).toBeNull();
  });

  it('describeDays says "every day" for none or all seven', () => {
    const name = (d: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] as string;
    expect(describeDays([], 'Every day', name)).toBe('Every day');
    expect(describeDays([0, 1, 2, 3, 4, 5, 6], 'Every day', name)).toBe('Every day');
    expect(describeDays([6, 0], 'Every day', name)).toBe('Sun, Sat');
  });

  it('endsNextDay: overnight ranges yes, a full day no', () => {
    expect(endsNextDay({ mode: 'FIXED', startTime: '22:00', endTime: '02:00' })).toBe(true);
    expect(endsNextDay({ mode: 'FIXED', startTime: '12:00', endTime: '16:00' })).toBe(false);
    expect(endsNextDay({ mode: 'FULL_DAY', startTime: '00:00', endTime: '00:00' })).toBe(false);
  });
});
