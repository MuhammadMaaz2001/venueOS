import { describe, expect, it } from 'vitest';
import {
  newTierRow,
  parseOptions,
  ruleEffect,
  rowsFromTiers,
  sortRowsByDays,
  suggestFieldKey,
  tierProblem,
  tiersFromRows,
} from './logic';

const rows = (...pairs: [string, string][]) => pairs.map(([d, p]) => newTierRow(d, p));

describe('tier editor logic', () => {
  it('turns tiers into rows and back', () => {
    const tiers = [
      { minDaysBefore: 60, refundPct: 80 },
      { minDaysBefore: 0, refundPct: 12.5 },
    ];
    expect(tiersFromRows(rowsFromTiers(tiers))).toEqual(tiers);
  });

  it('sorts from the longest notice to the shortest, blanks last', () => {
    const sorted = sortRowsByDays(rows(['0', '0'], ['', '10'], ['60', '80'], ['30', '50']));
    expect(sorted.map((r) => r.days)).toEqual(['60', '30', '0', '']);
  });

  it('accepts a good policy', () => {
    expect(tierProblem(rows(['60', '80'], ['30', '50'], ['0', '0']))).toBeNull();
  });

  it('names the problem', () => {
    expect(tierProblem([])).toBe('empty');
    expect(tierProblem(rows(['60', '80'], ['', '50'], ['0', '0']))).toBe('incomplete');
    expect(tierProblem(rows(['60', 'x'], ['0', '0']))).toBe('incomplete');
    expect(tierProblem(rows(['1.5', '10'], ['0', '0']))).toBe('incomplete');
    expect(tierProblem(rows(['30', '80'], ['30', '50'], ['0', '0']))).toBe('duplicate');
    expect(tierProblem(rows(['0', '0'], ['30', '50']))).toBe('order');
    expect(tierProblem(rows(['60', '80'], ['30', '50']))).toBe('last');
  });
});

describe('custom field helpers', () => {
  it('suggests a key from a label', () => {
    expect(suggestFieldKey('Family name')).toBe('family_name');
    expect(suggestFieldKey('  CNIC / ID  ')).toBe('cnic_id');
    expect(suggestFieldKey('2nd phone')).toBe('f_2nd_phone');
    expect(suggestFieldKey('!!!')).toBe('');
    expect(suggestFieldKey('a'.repeat(60)).length).toBeLessThanOrEqual(40);
  });

  it('parses choices from lines or commas without repeats', () => {
    expect(parseOptions('Bride, Groom\nBride\n\n  Guest  ')).toEqual(['Bride', 'Groom', 'Guest']);
    expect(parseOptions('  ')).toEqual([]);
  });
});

describe('ruleEffect', () => {
  const money = (v: string) => `PKR ${v}`;
  it('shows the sign of percent and fixed rules and the new rent of an override', () => {
    expect(ruleEffect('PERCENT', '20', money)).toBe('+20%');
    expect(ruleEffect('PERCENT', '-7.5', money)).toBe('-7.5%');
    expect(ruleEffect('FIXED_AMOUNT', '5000.00', money)).toBe('+PKR 5000.00');
    expect(ruleEffect('FIXED_AMOUNT', '-5000.00', money)).toBe('-PKR 5000.00');
    expect(ruleEffect('OVERRIDE', '150000.00', money)).toBe('= PKR 150000.00');
  });
});
