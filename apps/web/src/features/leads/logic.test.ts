import { describe, expect, it } from 'vitest';
import {
  followUpState,
  instantToLocalInput,
  localInputToInstant,
  presetFollowUp,
  reachableStages,
} from './logic';

const KARACHI = 'Asia/Karachi'; // UTC+5, no daylight saving
const NEW_YORK = 'America/New_York';

describe('local time <-> instant in the workspace zone', () => {
  it('reads a wall-clock value in the zone, not in the browser', () => {
    expect(localInputToInstant('2027-02-14T19:30', KARACHI)).toBe('2027-02-14T14:30:00.000Z');
    expect(localInputToInstant('2027-02-14T19:30', 'UTC')).toBe('2027-02-14T19:30:00.000Z');
    expect(localInputToInstant('2027-07-01T09:00', NEW_YORK)).toBe('2027-07-01T13:00:00.000Z');
    expect(localInputToInstant('2027-01-01T09:00', NEW_YORK)).toBe('2027-01-01T14:00:00.000Z');
  });

  it('round-trips', () => {
    for (const zone of [KARACHI, NEW_YORK, 'Asia/Kuwait', 'UTC']) {
      const instant = localInputToInstant('2027-03-20T10:15', zone) as string;
      expect(instantToLocalInput(instant, zone)).toBe('2027-03-20T10:15');
    }
  });

  it('refuses what is not a date and time', () => {
    for (const bad of ['', '2027-02-30T10:00', '2027-02-14', '2027-02-14T25:00', 'tomorrow']) {
      expect(localInputToInstant(bad, KARACHI), bad).toBeNull();
    }
  });
});

describe('presetFollowUp', () => {
  it('is 10:00 local, some days from today in the zone', () => {
    // 22:00 UTC on 13 Feb is already 03:00 on 14 Feb in Karachi.
    const now = new Date('2027-02-13T22:00:00Z');
    expect(presetFollowUp(0, KARACHI, now)).toBe('2027-02-14T10:00');
    expect(presetFollowUp(1, KARACHI, now)).toBe('2027-02-15T10:00');
    expect(presetFollowUp(3, 'UTC', now)).toBe('2027-02-16T10:00');
    expect(presetFollowUp(20, 'UTC', now)).toBe('2027-03-05T10:00');
  });
});

describe('followUpState', () => {
  const now = new Date('2027-02-14T08:00:00Z'); // 13:00 in Karachi
  it('tells overdue, later today, later and none apart', () => {
    expect(followUpState(null, now, KARACHI)).toBe('none');
    expect(followUpState('2027-02-14T07:59:00Z', now, KARACHI)).toBe('overdue');
    expect(followUpState('2027-02-14T12:00:00Z', now, KARACHI)).toBe('today'); // 17:00 local
    expect(followUpState('2027-02-14T19:30:00Z', now, KARACHI)).toBe('later'); // 00:30 next day local
    expect(followUpState('2027-02-20T10:00:00Z', now, KARACHI)).toBe('later');
  });
});

describe('reachableStages', () => {
  it('offers what the stage rules allow', () => {
    expect(reachableStages('NEW')).toEqual([
      'CONTACTED',
      'SITE_VISIT',
      'QUOTED',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(reachableStages('LOST')).toEqual([
      'NEW',
      'CONTACTED',
      'SITE_VISIT',
      'QUOTED',
      'NEGOTIATION',
    ]);
    expect(reachableStages('WON')).toEqual([]);
  });
});
