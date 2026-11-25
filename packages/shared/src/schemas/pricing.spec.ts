import { describe, expect, it } from 'vitest';
import {
  CreateCancellationPolicySchema,
  CreatePriceRuleSchema,
  CreateTaxRateSchema,
  RentPreviewQuerySchema,
  cancellationTierIssues,
  isRealDate,
  priceRuleShapeIssues,
} from './pricing.js';

describe('cancellation tiers', () => {
  const ok = [
    { minDaysBefore: 60, refundPct: 80 },
    { minDaysBefore: 30, refundPct: 50 },
    { minDaysBefore: 0, refundPct: 0 },
  ];

  it('accepts descending days that end at 0', () => {
    expect(cancellationTierIssues(ok)).toEqual([]);
    expect(cancellationTierIssues([{ minDaysBefore: 0, refundPct: 100 }])).toEqual([]);
  });

  it('rejects a missing 0-day tier', () => {
    expect(
      cancellationTierIssues([
        { minDaysBefore: 60, refundPct: 80 },
        { minDaysBefore: 30, refundPct: 50 },
      ]),
    ).toEqual([{ path: '1.minDaysBefore', message: 'The last tier must be 0 days' }]);
  });

  it('rejects duplicate days', () => {
    const issues = cancellationTierIssues([
      { minDaysBefore: 30, refundPct: 80 },
      { minDaysBefore: 30, refundPct: 50 },
      { minDaysBefore: 0, refundPct: 0 },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['1.minDaysBefore']);
  });

  it('rejects ascending order', () => {
    const issues = cancellationTierIssues([
      { minDaysBefore: 0, refundPct: 0 },
      { minDaysBefore: 30, refundPct: 50 },
    ]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects an empty list', () => {
    expect(cancellationTierIssues([]).length).toBe(1);
    expect(CreateCancellationPolicySchema.safeParse({ name: 'x', tiers: [] }).success).toBe(false);
  });

  it('bounds refundPct to 0..100 with at most 2 decimals', () => {
    const base = { name: 'P', tiers: [{ minDaysBefore: 0, refundPct: 0 }] };
    expect(CreateCancellationPolicySchema.safeParse(base).success).toBe(true);
    for (const refundPct of [-1, 100.5, 12.345]) {
      expect(
        CreateCancellationPolicySchema.safeParse({
          ...base,
          tiers: [{ minDaysBefore: 0, refundPct }],
        }).success,
        String(refundPct),
      ).toBe(false);
    }
    expect(
      CreateCancellationPolicySchema.safeParse({
        ...base,
        tiers: [{ minDaysBefore: 0, refundPct: 12.5 }],
      }).success,
    ).toBe(true);
  });

  it('reports a bad order as an issue on the tier through the schema', () => {
    const res = CreateCancellationPolicySchema.safeParse({
      name: 'P',
      tiers: [
        { minDaysBefore: 10, refundPct: 50 },
        { minDaysBefore: 20, refundPct: 20 },
        { minDaysBefore: 0, refundPct: 0 },
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['tiers', 1, 'minDaysBefore']);
  });
});

describe('price rule shape', () => {
  const base = {
    daysOfWeek: [],
    startDate: null,
    endDate: null,
    adjustment: 'PERCENT',
    value: '20',
  } as const;
  const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

  it('needs weekdays and no dates for DAY_OF_WEEK', () => {
    expect(priceRuleShapeIssues({ ...base, kind: 'DAY_OF_WEEK', daysOfWeek: [5, 6] })).toEqual([]);
    expect(paths(priceRuleShapeIssues({ ...base, kind: 'DAY_OF_WEEK' }))).toEqual(['daysOfWeek']);
    expect(
      paths(
        priceRuleShapeIssues({
          ...base,
          kind: 'DAY_OF_WEEK',
          daysOfWeek: [1],
          startDate: '2027-01-01',
        }),
      ),
    ).toEqual(['startDate']);
  });

  it('needs an ordered start and end for DATE_RANGE', () => {
    const rule = { ...base, kind: 'DATE_RANGE' } as const;
    expect(
      priceRuleShapeIssues({ ...rule, startDate: '2027-11-01', endDate: '2027-12-31' }),
    ).toEqual([]);
    expect(
      priceRuleShapeIssues({ ...rule, startDate: '2027-11-01', endDate: '2027-11-01' }),
    ).toEqual([]);
    expect(
      paths(priceRuleShapeIssues({ ...rule, startDate: '2027-12-31', endDate: '2027-11-01' })),
    ).toEqual(['endDate']);
    expect(paths(priceRuleShapeIssues({ ...rule, startDate: '2027-11-01' }))).toEqual(['endDate']);
    expect(paths(priceRuleShapeIssues(rule))).toEqual(['startDate', 'endDate']);
    expect(
      paths(priceRuleShapeIssues({ ...rule, startDate: '2027-02-30', endDate: '2027-03-01' })),
    ).toEqual(['startDate']);
    expect(
      paths(
        priceRuleShapeIssues({
          ...rule,
          daysOfWeek: [1],
          startDate: '2027-01-01',
          endDate: '2027-01-02',
        }),
      ),
    ).toEqual(['daysOfWeek']);
  });

  it('needs exactly one date for SPECIFIC_DATE', () => {
    const rule = { ...base, kind: 'SPECIFIC_DATE' } as const;
    expect(priceRuleShapeIssues({ ...rule, startDate: '2027-03-23' })).toEqual([]);
    expect(paths(priceRuleShapeIssues(rule))).toEqual(['startDate']);
    expect(
      paths(priceRuleShapeIssues({ ...rule, startDate: '2027-03-23', endDate: '2027-03-24' })),
    ).toEqual(['endDate']);
  });

  it('checks the value against the adjustment', () => {
    const rule = { ...base, kind: 'DAY_OF_WEEK', daysOfWeek: [0] } as const;
    const bad = (adjustment: 'PERCENT' | 'FIXED_AMOUNT' | 'OVERRIDE', value: string) =>
      priceRuleShapeIssues({ ...rule, adjustment, value }).length > 0;
    expect(bad('PERCENT', '20')).toBe(false);
    expect(bad('PERCENT', '-100')).toBe(false);
    expect(bad('PERCENT', '-100.5')).toBe(true);
    expect(bad('PERCENT', '1001')).toBe(true);
    expect(bad('PERCENT', '0')).toBe(true);
    expect(bad('FIXED_AMOUNT', '-5000')).toBe(false);
    expect(bad('FIXED_AMOUNT', '0.00')).toBe(true);
    expect(bad('OVERRIDE', '0')).toBe(false);
    expect(bad('OVERRIDE', '-1')).toBe(true);
    expect(bad('OVERRIDE', 'abc')).toBe(true);
  });

  it('is applied by the create schema', () => {
    const ok = CreatePriceRuleSchema.safeParse({
      name: 'Weekend',
      kind: 'DAY_OF_WEEK',
      daysOfWeek: [5, 6],
      adjustment: 'PERCENT',
      value: '20',
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.priority).toBe(0);
    expect(
      CreatePriceRuleSchema.safeParse({
        name: 'x',
        kind: 'DAY_OF_WEEK',
        adjustment: 'PERCENT',
        value: '20',
      }).success,
    ).toBe(false);
  });

  it('recognises real dates only', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('1999-12-31')).toBe(false);
    expect(isRealDate('2027-1-1')).toBe(false);
  });
});

describe('tax rates and the rent preview query', () => {
  it('bounds the rate to 0..100', () => {
    const rate = (ratePct: string) =>
      CreateTaxRateSchema.safeParse({ name: 'GST', ratePct }).success;
    expect(rate('16')).toBe(true);
    expect(rate('16.5')).toBe(true);
    expect(rate('100')).toBe(true);
    expect(rate('100.01')).toBe(false);
    expect(rate('-1')).toBe(false);
    expect(rate('16.123')).toBe(false);
  });

  it('takes hours with at most 2 decimals', () => {
    const q = { venueId: 'v', spaceId: 's', slotId: 'l', date: '2027-03-23' };
    expect(RentPreviewQuerySchema.safeParse({ ...q, hours: '5.5' }).success).toBe(true);
    expect(RentPreviewQuerySchema.safeParse({ ...q, hours: '5.555' }).success).toBe(false);
    expect(RentPreviewQuerySchema.safeParse({ ...q, date: '2027-13-01' }).success).toBe(false);
  });
});
