import { describe, expect, it } from 'vitest';
import { applyPriceRules, baseRent, ruleMatches, weekdayOf } from './price-rules';
import type { PricingRule, RuleContext } from './price-rules';

// docs/05-business-rules.md section 3, steps 1 and 2. 2027-01-01 is a Friday.
const FRIDAY = '2027-01-01';
const SATURDAY = '2027-01-02';
const MONDAY = '2027-01-04';
const ctx = (date: string, spaceId = 'hallA', slotId = 'dinner'): RuleContext => ({
  spaceId,
  slotId,
  date,
});

let counter = 0;
const rule = (over: Partial<PricingRule>): PricingRule => ({
  id: `rule_${String(++counter).padStart(3, '0')}`,
  name: 'rule',
  kind: 'DAY_OF_WEEK',
  spaceId: null,
  slotId: null,
  daysOfWeek: [],
  startDate: null,
  endDate: null,
  adjustment: 'PERCENT',
  value: '0',
  priority: 0,
  ...over,
});
const weekend = (over: Partial<PricingRule> = {}) =>
  rule({ name: 'Weekend', daysOfWeek: [5, 6], adjustment: 'PERCENT', value: '20', ...over });
const season = (over: Partial<PricingRule> = {}) =>
  rule({
    name: 'Season',
    kind: 'DATE_RANGE',
    startDate: '2026-11-01',
    endDate: '2027-02-28',
    adjustment: 'PERCENT',
    value: '10',
    ...over,
  });

const run = (rules: PricingRule[], date: string, base = '100000', currency = 'PKR') =>
  applyPriceRules({ baseRent: base, currency, rules, context: ctx(date) });
const amounts = (r: ReturnType<typeof run>) => r.applied.map((a) => a.amount.toString());

describe('weekdayOf', () => {
  it('is 0 for Sunday .. 6 for Saturday, from the date alone', () => {
    expect(weekdayOf(FRIDAY)).toBe(5);
    expect(weekdayOf(SATURDAY)).toBe(6);
    expect(weekdayOf('2027-01-03')).toBe(0);
    expect(weekdayOf(MONDAY)).toBe(1);
    expect(weekdayOf('2028-02-29')).toBe(2);
  });
  it('rejects text that is not a date', () => {
    expect(() => weekdayOf('2027-1-1')).toThrow(RangeError);
  });
});

describe('ruleMatches', () => {
  it('matches a weekday rule on its days only', () => {
    const r = weekend();
    expect(ruleMatches(r, ctx(FRIDAY))).toBe(true);
    expect(ruleMatches(r, ctx(SATURDAY))).toBe(true);
    expect(ruleMatches(r, ctx(MONDAY))).toBe(false);
  });

  it('matches a season on both boundary days and nothing outside', () => {
    const r = season({ startDate: '2027-01-02', endDate: '2027-01-04' });
    expect(ruleMatches(r, ctx('2027-01-01'))).toBe(false);
    expect(ruleMatches(r, ctx('2027-01-02'))).toBe(true);
    expect(ruleMatches(r, ctx('2027-01-03'))).toBe(true);
    expect(ruleMatches(r, ctx('2027-01-04'))).toBe(true);
    expect(ruleMatches(r, ctx('2027-01-05'))).toBe(false);
  });

  it('matches a specific date on that day only', () => {
    const r = rule({ kind: 'SPECIFIC_DATE', startDate: '2027-03-23' });
    expect(ruleMatches(r, ctx('2027-03-23'))).toBe(true);
    expect(ruleMatches(r, ctx('2027-03-24'))).toBe(false);
  });

  it('respects the space and slot scope (null = all)', () => {
    const forHallB = weekend({ spaceId: 'hallB' });
    expect(ruleMatches(forHallB, ctx(FRIDAY, 'hallA'))).toBe(false);
    expect(ruleMatches(forHallB, ctx(FRIDAY, 'hallB'))).toBe(true);
    const forLunch = weekend({ slotId: 'lunch' });
    expect(ruleMatches(forLunch, ctx(FRIDAY, 'hallA', 'dinner'))).toBe(false);
    expect(ruleMatches(forLunch, ctx(FRIDAY, 'hallA', 'lunch'))).toBe(true);
    const both = weekend({ spaceId: 'hallA', slotId: 'dinner' });
    expect(ruleMatches(both, ctx(FRIDAY))).toBe(true);
    expect(ruleMatches(both, ctx(FRIDAY, 'hallA', 'lunch'))).toBe(false);
  });
});

describe('applyPriceRules', () => {
  it('leaves the rent alone when nothing matches', () => {
    const r = run([weekend()], MONDAY);
    expect(r.applied).toEqual([]);
    expect(r.finalRent.toString()).toBe('100000');
  });

  it('weekend +20% on a Saturday, as a line of +20000', () => {
    const r = run([weekend()], SATURDAY);
    expect(amounts(r)).toEqual(['20000']);
    expect(r.finalRent.toString()).toBe('120000');
    expect(r.applied[0]?.rentAfter.toString()).toBe('120000');
  });

  it('a weekday rule, a season and a specific date all apply, compounding on the running rent', () => {
    const rules = [
      weekend({ priority: 3 }),
      season({ priority: 2 }),
      rule({
        kind: 'SPECIFIC_DATE',
        startDate: SATURDAY,
        adjustment: 'FIXED_AMOUNT',
        value: '5000',
        priority: 1,
      }),
    ];
    const r = run(rules, SATURDAY);
    // 100000 +20% = 120000, +10% = 132000, +5000 = 137000
    expect(amounts(r)).toEqual(['20000', '12000', '5000']);
    expect(r.finalRent.toString()).toBe('137000');
  });

  it('applies rules highest priority first, so priority changes the result', () => {
    const percent = (priority: number) => weekend({ priority, value: '10' });
    const fixed = (priority: number) =>
      rule({ daysOfWeek: [5, 6], adjustment: 'FIXED_AMOUNT', value: '10000', priority });
    // fixed first: (100000 + 10000) x 1.1 = 121000
    expect(run([percent(1), fixed(2)], SATURDAY).finalRent.toString()).toBe('121000');
    // percent first: 100000 x 1.1 + 10000 = 120000
    expect(run([percent(2), fixed(1)], SATURDAY).finalRent.toString()).toBe('120000');
  });

  it('at the same priority a percentage comes before a fixed amount, whatever the input order', () => {
    const percent = weekend({ value: '10', priority: 4 });
    const fixed = rule({
      daysOfWeek: [6],
      adjustment: 'FIXED_AMOUNT',
      value: '10000',
      priority: 4,
    });
    const a = run([fixed, percent], SATURDAY);
    const b = run([percent, fixed], SATURDAY);
    expect(a.finalRent.toString()).toBe('120000');
    expect(b.finalRent.toString()).toBe('120000');
    expect(a.applied.map((x) => x.rule.adjustment)).toEqual(['PERCENT', 'FIXED_AMOUNT']);
  });

  it('an override replaces the rent; the highest priority wins; the loser is reported, not applied', () => {
    const low = rule({
      name: 'Low',
      kind: 'DATE_RANGE',
      startDate: '2027-01-01',
      endDate: '2027-01-31',
      adjustment: 'OVERRIDE',
      value: '150000',
      priority: 1,
    });
    const high = rule({
      name: 'High',
      kind: 'SPECIFIC_DATE',
      startDate: SATURDAY,
      adjustment: 'OVERRIDE',
      value: '200000',
      priority: 9,
    });
    const r = run([low, high], SATURDAY);
    expect(r.finalRent.toString()).toBe('200000');
    expect(amounts(r)).toEqual(['100000']);
    expect(r.applied[0]?.rule.name).toBe('High');
    expect(r.notApplied.map((x) => x.name)).toEqual(['Low']);
  });

  it('percent and fixed rules apply on top of the override', () => {
    const override = season({ adjustment: 'OVERRIDE', value: '150000', priority: 5 });
    const r = run([weekend(), override], SATURDAY);
    // 100000 -> override 150000 -> +20% = 180000
    expect(amounts(r)).toEqual(['50000', '30000']);
    expect(r.finalRent.toString()).toBe('180000');
  });

  it('an override can lower the rent (negative line)', () => {
    const r = run([season({ adjustment: 'OVERRIDE', value: '80000' })], FRIDAY);
    expect(amounts(r)).toEqual(['-20000']);
    expect(r.finalRent.toString()).toBe('80000');
  });

  it('equal priority overrides are decided the same way every time: more specific kind, then scope, then id', () => {
    const range = rule({
      id: 'a',
      kind: 'DATE_RANGE',
      startDate: '2027-01-01',
      endDate: '2027-01-31',
      adjustment: 'OVERRIDE',
      value: '1',
      priority: 2,
    });
    const day = rule({
      id: 'b',
      kind: 'SPECIFIC_DATE',
      startDate: SATURDAY,
      adjustment: 'OVERRIDE',
      value: '2',
      priority: 2,
    });
    expect(run([range, day], SATURDAY).finalRent.toString()).toBe('2');
    expect(run([day, range], SATURDAY).finalRent.toString()).toBe('2');

    const anySpace = rule({
      id: 'a',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [6],
      adjustment: 'OVERRIDE',
      value: '1',
      priority: 2,
    });
    const thisSpace = rule({
      id: 'b',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [6],
      spaceId: 'hallA',
      adjustment: 'OVERRIDE',
      value: '2',
      priority: 2,
    });
    expect(run([anySpace, thisSpace], SATURDAY).finalRent.toString()).toBe('2');

    const first = rule({
      id: 'a',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [6],
      adjustment: 'OVERRIDE',
      value: '1',
      priority: 2,
    });
    const second = rule({
      id: 'b',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [6],
      adjustment: 'OVERRIDE',
      value: '2',
      priority: 2,
    });
    expect(run([second, first], SATURDAY).finalRent.toString()).toBe('1');
  });

  it('a rule for another space or slot does not apply', () => {
    const r = run([weekend({ spaceId: 'hallB' }), weekend({ slotId: 'lunch' })], SATURDAY);
    expect(r.applied).toEqual([]);
  });

  it('a negative percentage is a discount', () => {
    const r = run([weekend({ value: '-15' })], SATURDAY);
    expect(r.finalRent.toString()).toBe('85000');
    expect(amounts(r)).toEqual(['-15000']);
  });

  it('never goes below 0: the line is cut so the lines still add up', () => {
    const r = run(
      [rule({ daysOfWeek: [6], adjustment: 'FIXED_AMOUNT', value: '-150000' })],
      SATURDAY,
    );
    expect(r.finalRent.toString()).toBe('0');
    expect(amounts(r)).toEqual(['-100000']);
    const sum = r.applied.reduce((s, a) => s.plus(a.amount), r.baseRent);
    expect(sum.toString()).toBe(r.finalRent.toString());
  });

  it('rounds each line half-up to the currency minor unit (PKR 2, KWD 3, JPY 0)', () => {
    // 1000.01 x 3.335% = 33.3503... -> 33.35 ; running 1033.36
    const pkr = run([weekend({ value: '3.335' })], SATURDAY, '1000.01', 'PKR');
    expect(amounts(pkr)).toEqual(['33.35']);
    expect(pkr.finalRent.toFixed(2)).toBe('1033.36');
    // tie rounds away from zero: 100.125 x 1% = 1.00125 -> 1.001 (KWD)
    const kwd = run([weekend({ value: '1' })], SATURDAY, '100.125', 'KWD');
    expect(amounts(kwd)).toEqual(['1.001']);
    // 1005 x 10% = 100.5 -> 101 (JPY, half-up)
    const jpy = run([weekend({ value: '10' })], SATURDAY, '1005', 'JPY');
    expect(amounts(jpy)).toEqual(['101']);
    expect(jpy.finalRent.toString()).toBe('1106');
  });

  it('rounds the fixed amount and an override to the minor unit too', () => {
    const r = run(
      [rule({ daysOfWeek: [6], adjustment: 'FIXED_AMOUNT', value: '10.005' })],
      SATURDAY,
      '100',
      'PKR',
    );
    expect(amounts(r)).toEqual(['10.01']);
  });

  it('the lines always add up: base + sum(lines) = final', () => {
    const rules = [
      weekend({ value: '7.77', priority: 3 }),
      season({ value: '-3.33', priority: 2 }),
      rule({ daysOfWeek: [6], adjustment: 'FIXED_AMOUNT', value: '123.45', priority: 1 }),
    ];
    const r = run(rules, SATURDAY, '98765.43');
    const sum = r.applied.reduce((s, a) => s.plus(a.amount), r.baseRent);
    expect(sum.toString()).toBe(r.finalRent.toString());
  });
});

describe('baseRent', () => {
  it('is the slot rent for a fixed slot', () => {
    expect(baseRent('120000', null, 'PKR').toString()).toBe('120000');
  });
  it('is the hourly rent times the hours, rounded, for an hourly slot', () => {
    expect(baseRent('5000.50', '2.5', 'PKR').toFixed(2)).toBe('12501.25');
    expect(baseRent('3.333', '3', 'KWD').toFixed(3)).toBe('9.999');
    expect(baseRent('1.005', '1', 'PKR').toFixed(2)).toBe('1.01');
  });
});
