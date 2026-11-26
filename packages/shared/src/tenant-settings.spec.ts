import { describe, expect, it } from 'vitest';
import { TenantSettings, parseTenantSettings } from './tenant-settings.js';

describe('TenantSettings defaults (docs/05 §15)', () => {
  const DEFAULTS = {
    bookingPrefix: 'BK',
    holdHours: 48,
    advancePct: 50,
    tokenAmount: '0',
    balanceDueDays: 7,
    guestLockDays: 3,
    reminderDays: 3,
    eventReminderDays: 2,
    minHours: 2,
    quotationValidDays: 14,
    holdWarnHours: 6,
  };

  it('fills every default from an empty object, null and undefined', () => {
    expect(parseTenantSettings({})).toEqual(DEFAULTS);
    expect(parseTenantSettings(null)).toEqual(DEFAULTS);
    expect(parseTenantSettings(undefined)).toEqual(DEFAULTS);
  });

  it('keeps provided values and fills the rest', () => {
    expect(
      parseTenantSettings({ holdHours: 24, bookingPrefix: 'RB', tokenAmount: '5000' }),
    ).toEqual({
      ...DEFAULTS,
      holdHours: 24,
      bookingPrefix: 'RB',
      tokenAmount: '5000',
    });
  });

  it('drops unknown keys', () => {
    expect(parseTenantSettings({ legacyThing: 1 })).toEqual(DEFAULTS);
  });

  it.each([
    { holdHours: 0 },
    { holdHours: 1.5 },
    { advancePct: 101 },
    { advancePct: -1 },
    { bookingPrefix: 'bk' },
    { bookingPrefix: '' },
    { bookingPrefix: 'TOOLONGPREFIX' },
    { tokenAmount: 5000 }, // money is a string, never a number
    { tokenAmount: '-1' },
    { tokenAmount: '1e3' },
    { minHours: 0 },
    { reminderDays: '3' },
  ])('rejects invalid input %j', (bad) => {
    expect(TenantSettings.safeParse(bad).success).toBe(false);
  });
});
