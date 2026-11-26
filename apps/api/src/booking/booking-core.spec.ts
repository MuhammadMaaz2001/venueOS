import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../common/errors/domain-errors';
import { advanceMet, applicableTier, clearedNet, requiredAdvance, suggestRefund } from './refund';
import { localRuleBreaches, occupancyRange, sessionTimes } from './timing';
import type { SlotWindowInput } from './timing';

const KARACHI = 'Asia/Karachi'; // UTC+5, no daylight saving
const dinner: SlotWindowInput = {
  mode: 'FIXED',
  startTime: '19:00',
  endTime: '23:30',
  minHours: null,
  defaultMinHours: 2,
};
const lunch: SlotWindowInput = {
  mode: 'FIXED',
  startTime: '12:00',
  endTime: '16:00',
  minHours: null,
  defaultMinHours: 2,
};
const night: SlotWindowInput = {
  mode: 'FIXED',
  startTime: '22:00',
  endTime: '02:00',
  minHours: null,
  defaultMinHours: 2,
};
const fullDay: SlotWindowInput = {
  mode: 'FULL_DAY',
  startTime: '00:00',
  endTime: '00:00',
  minHours: null,
  defaultMinHours: 2,
};
const hourly: SlotWindowInput = {
  mode: 'HOURLY',
  startTime: '10:00',
  endTime: '23:00',
  minHours: 3,
  defaultMinHours: 2,
};

describe('sessionTimes', () => {
  it('a fixed slot is the template on that day, in the venue time zone', () => {
    const t = sessionTimes(dinner, '2027-02-14', KARACHI, {});
    expect(t.startsAt.toISOString()).toBe('2027-02-14T14:00:00.000Z');
    expect(t.endsAt.toISOString()).toBe('2027-02-14T18:30:00.000Z');
    expect(t.hours).toBe('4.5');
  });

  it('a slot that ends earlier than it starts ends the next day', () => {
    const t = sessionTimes(night, '2027-02-14', KARACHI, {});
    expect(t.startsAt.toISOString()).toBe('2027-02-14T17:00:00.000Z');
    expect(t.endsAt.toISOString()).toBe('2027-02-14T21:00:00.000Z');
    expect(t.hours).toBe('4');
  });

  it('a full day is 24 hours from midnight to midnight', () => {
    const t = sessionTimes(fullDay, '2027-02-14', KARACHI, {});
    expect(t.startsAt.toISOString()).toBe('2027-02-13T19:00:00.000Z');
    expect(t.endsAt.toISOString()).toBe('2027-02-14T19:00:00.000Z');
    expect(t.hours).toBe('24');
  });

  it('an hourly slot takes the requested times inside its window and at least the minimum hours', () => {
    const t = sessionTimes(hourly, '2027-02-14', KARACHI, { startTime: '14:00', endTime: '18:30' });
    expect(t.hours).toBe('4.5');
    expect(t.startsAt.toISOString()).toBe('2027-02-14T09:00:00.000Z');
    const wholeWindow = sessionTimes(hourly, '2027-02-14', KARACHI, {});
    expect(wholeWindow.hours).toBe('13');
    expect(() =>
      sessionTimes(hourly, '2027-02-14', KARACHI, { startTime: '09:00', endTime: '14:00' }),
    ).toThrow(FieldValidationError);
    expect(() =>
      sessionTimes(hourly, '2027-02-14', KARACHI, { startTime: '20:00', endTime: '23:30' }),
    ).toThrow(FieldValidationError);
    expect(() =>
      sessionTimes(hourly, '2027-02-14', KARACHI, { startTime: '14:00', endTime: '16:00' }),
    ).toThrow(FieldValidationError);
  });

  it('only an hourly slot has its own times', () => {
    expect(() => sessionTimes(dinner, '2027-02-14', KARACHI, { startTime: '19:00' })).toThrow(
      FieldValidationError,
    );
  });

  it('uses the zone, also where it has daylight saving (New York, 14 Mar 2027 starts DST at 02:00)', () => {
    const before = sessionTimes(lunch, '2027-03-13', 'America/New_York', {});
    expect(before.startsAt.toISOString()).toBe('2027-03-13T17:00:00.000Z'); // UTC-5
    const after = sessionTimes(lunch, '2027-03-15', 'America/New_York', {});
    expect(after.startsAt.toISOString()).toBe('2027-03-15T16:00:00.000Z'); // UTC-4
    expect(after.hours).toBe('4');
  });
});

describe('occupancyRange', () => {
  it('widens the event by the setup and cleanup buffers; back-to-back sessions only touch', () => {
    const l = sessionTimes(lunch, '2027-02-14', KARACHI, {});
    const d = sessionTimes(dinner, '2027-02-14', KARACHI, {});
    const lr = occupancyRange(l.startsAt, l.endsAt, 60, 30);
    expect(lr.startsAt.toISOString()).toBe('2027-02-14T06:00:00.000Z');
    expect(lr.endsAt.toISOString()).toBe('2027-02-14T11:30:00.000Z');
    const touching = occupancyRange(l.startsAt, l.endsAt, 0, 0);
    expect(touching.endsAt.getTime()).toBeLessThanOrEqual(d.startsAt.getTime());
  });
});

describe('localRuleBreaches', () => {
  const at = (slot: SlotWindowInput, date = '2027-02-14') => sessionTimes(slot, date, KARACHI, {});
  it('latestEndTime: a session ending after it breaks the rule', () => {
    const rules = { latestEndTime: '22:00' };
    expect(localRuleBreaches(rules, { ...at(dinner), guests: 100 }, KARACHI)).toEqual([
      'LATEST_END_TIME',
    ]);
    expect(localRuleBreaches(rules, { ...at(lunch), guests: 100 }, KARACHI)).toEqual([]);
    expect(
      localRuleBreaches({ latestEndTime: '23:30' }, { ...at(dinner), guests: 1 }, KARACHI),
    ).toEqual([]);
  });

  it('latestEndTime after midnight is the next day, and an end next day breaks an earlier limit', () => {
    expect(
      localRuleBreaches({ latestEndTime: '02:00' }, { ...at(night), guests: 1 }, KARACHI),
    ).toEqual([]);
    expect(
      localRuleBreaches({ latestEndTime: '01:00' }, { ...at(night), guests: 1 }, KARACHI),
    ).toEqual(['LATEST_END_TIME']);
    expect(
      localRuleBreaches({ latestEndTime: '23:00' }, { ...at(night), guests: 1 }, KARACHI),
    ).toEqual(['LATEST_END_TIME']);
  });

  it('maxGuests', () => {
    const t = at(lunch);
    expect(localRuleBreaches({ maxGuests: 500 }, { ...t, guests: 500 }, KARACHI)).toEqual([]);
    expect(localRuleBreaches({ maxGuests: 500 }, { ...t, guests: 501 }, KARACHI)).toEqual([
      'MAX_GUESTS',
    ]);
    expect(
      localRuleBreaches({ maxGuests: 100, latestEndTime: '15:00' }, { ...t, guests: 200 }, KARACHI),
    ).toEqual(['MAX_GUESTS', 'LATEST_END_TIME']);
    expect(localRuleBreaches({}, { ...t, guests: 99999 }, KARACHI)).toEqual([]);
  });
});

describe('cancellation refund suggestion (docs/05 section 6)', () => {
  const tiers = [
    { minDaysBefore: 30, refundPct: 50 },
    { minDaysBefore: 60, refundPct: 80 },
    { minDaysBefore: 0, refundPct: 0 },
  ];

  it('picks the tier of the longest notice that is met', () => {
    expect(applicableTier(tiers, 90)?.refundPct).toBe(80);
    expect(applicableTier(tiers, 60)?.refundPct).toBe(80);
    expect(applicableTier(tiers, 59)?.refundPct).toBe(50);
    expect(applicableTier(tiers, 30)?.refundPct).toBe(50);
    expect(applicableTier(tiers, 29)?.refundPct).toBe(0);
    expect(applicableTier(tiers, 0)?.refundPct).toBe(0);
    expect(applicableTier(tiers, -1)).toBeNull();
    expect(applicableTier([], 10)).toBeNull();
  });

  it('suggests the share of what was paid, rounded to the currency', () => {
    expect(suggestRefund(tiers, 75, '100000', 'PKR')).toEqual({
      daysBefore: 75,
      refundPct: 80,
      received: '100000',
      suggested: '80000',
    });
    expect(suggestRefund(tiers, 45, '33333.33', 'PKR').suggested).toBe('16666.67'); // 16666.665 half-up
    expect(suggestRefund(tiers, 45, '10', 'JPY').suggested).toBe('5');
    expect(suggestRefund(tiers, 5, '100000', 'PKR').suggested).toBe('0');
    expect(suggestRefund(tiers, 75, '0', 'PKR').suggested).toBe('0');
    expect(suggestRefund(tiers, 75, '-50', 'PKR').suggested).toBe('0');
    expect(suggestRefund([], 75, '1000', 'PKR').refundPct).toBe(0);
  });
});

describe('cleared payments and the advance (docs/05 sections 2 and 5)', () => {
  const row = (
    id: string,
    entryType: 'RECEIPT' | 'REFUND' | 'REVERSAL',
    amount: string,
    status: 'PENDING' | 'CLEARED' | 'BOUNCED' = 'CLEARED',
    reversesId: string | null = null,
  ) => ({ id, entryType, amount, status, reversesId });

  it('counts cleared receipts minus cleared refunds', () => {
    expect(
      clearedNet([
        row('a', 'RECEIPT', '50000'),
        row('b', 'RECEIPT', '25000'),
        row('c', 'REFUND', '5000'),
      ]),
    ).toBe('70000');
    expect(clearedNet([])).toBe('0');
  });

  it('a pending or bounced cheque never counts', () => {
    expect(
      clearedNet([row('a', 'RECEIPT', '50000', 'PENDING'), row('b', 'RECEIPT', '9000', 'BOUNCED')]),
    ).toBe('0');
  });

  it('a reversal takes back the receipt it points to (and gives back a refund)', () => {
    expect(
      clearedNet([row('a', 'RECEIPT', '50000'), row('r', 'REVERSAL', '50000', 'CLEARED', 'a')]),
    ).toBe('0');
    expect(
      clearedNet([
        row('a', 'RECEIPT', '50000'),
        row('f', 'REFUND', '10000'),
        row('r', 'REVERSAL', '10000', 'CLEARED', 'f'),
      ]),
    ).toBe('50000');
    // A reversal of a pending entry reverses nothing that counted.
    expect(
      clearedNet([
        row('a', 'RECEIPT', '50000', 'PENDING'),
        row('r', 'REVERSAL', '50000', 'CLEARED', 'a'),
      ]),
    ).toBe('0');
  });

  it('the advance is advancePct of the grand total, compared exactly', () => {
    expect(requiredAdvance('200000', 50)).toBe('100000');
    expect(requiredAdvance('333.33', 50)).toBe('166.665');
    expect(advanceMet('100000', '200000', 50)).toBe(true);
    expect(advanceMet('99999.99', '200000', 50)).toBe(false);
    expect(advanceMet('166.66', '333.33', 50)).toBe(false);
    expect(advanceMet('0', '0', 50)).toBe(true);
    expect(advanceMet('0', '200000', 0)).toBe(true);
  });
});
