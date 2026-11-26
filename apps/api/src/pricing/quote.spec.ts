import { describe, expect, it } from 'vitest';
import { money } from '@venueos/shared';
import {
  DiscountExceedsSubtotalError,
  DiscountLimitExceededError,
  addOnQuantity,
  billedGuests,
  lineSignIsValid,
  priceQuote,
} from './quote';
import type { FrozenSessionPricing, QuoteInput, QuoteSessionInput } from './quote';

// docs/05 section 3, step by step: rent and rules, package, add-ons, discount, tax; rounding, signs and the sums.

// 2027-02-14 is a Sunday (weekday 0).
const SUNDAY_PLUS_20 = {
  id: 'r1',
  name: 'Sunday premium',
  kind: 'DAY_OF_WEEK' as const,
  spaceId: null,
  slotId: null,
  daysOfWeek: [0],
  startDate: null,
  endDate: null,
  adjustment: 'PERCENT' as const,
  value: '20',
  priority: 1,
};

function frozen(over: Partial<FrozenSessionPricing> = {}): FrozenSessionPricing {
  return { unitRent: '100000', rentHours: null, rules: [], package: null, addOns: [], ...over };
}

function session(over: Partial<QuoteSessionInput> = {}): QuoteSessionInput {
  return {
    index: 0,
    label: 'Barat, Hall A, Dinner',
    date: '2027-02-14',
    spaceId: 's1',
    slotId: 'dinner',
    hours: '4.5',
    guests: 200,
    guaranteedGuests: null,
    addOnQuantities: {},
    frozen: frozen(),
    ...over,
  };
}

function quote(over: Partial<QuoteInput> = {}, sessions: QuoteSessionInput[] = [session()]) {
  return priceQuote({
    currency: 'PKR',
    sessions,
    taxRate: null,
    discount: null,
    maxDiscountPct: 10,
    ...over,
  });
}

const amounts = (r: ReturnType<typeof priceQuote>) =>
  r.lines.map((l) => [l.kind, l.amount] as const);
const sum = (values: string[]) => values.reduce((t, v) => t.plus(v), money('0'));

describe('billedGuests', () => {
  it('is the largest of guests, package minimum and guaranteed guests', () => {
    expect(billedGuests(200, null, null)).toBe(200);
    expect(billedGuests(200, 250, null)).toBe(250);
    expect(billedGuests(200, 150, 300)).toBe(300);
    expect(billedGuests(400, 150, 300)).toBe(400);
    expect(billedGuests(50, undefined, undefined)).toBe(50);
  });
});

describe('step 1: rent and price rules', () => {
  it('a fixed slot is one rent line', () => {
    const r = quote();
    expect(amounts(r)).toEqual([['RENT', '100000']]);
    expect(r.lines[0]).toMatchObject({ quantity: '1', unitPrice: '100000', sessionIndex: 0 });
    expect(r.grandTotal).toBe('100000');
  });

  it('an hourly slot is rent per hour x hours, rounded', () => {
    const r = quote({}, [session({ frozen: frozen({ unitRent: '3333.33', rentHours: '2.5' }) })]);
    expect(amounts(r)).toEqual([['RENT', '8333.33']]);
    expect(r.lines[0]).toMatchObject({ quantity: '2.5', unitPrice: '3333.33' });
  });

  it('every price rule that applies is its own signed ADJUSTMENT line', () => {
    const r = quote({}, [session({ frozen: frozen({ rules: [SUNDAY_PLUS_20] }) })]);
    expect(amounts(r)).toEqual([
      ['RENT', '100000'],
      ['ADJUSTMENT', '20000'],
    ]);
    expect(r.lines[1]).toMatchObject({ refType: 'price_rule', refId: 'r1' });
    expect(r.grandTotal).toBe('120000');
  });

  it('a rule that does not match the day is ignored; a discount-like rule is a negative adjustment', () => {
    const monday = quote({}, [
      session({ date: '2027-02-15', frozen: frozen({ rules: [SUNDAY_PLUS_20] }) }),
    ]);
    expect(monday.lines).toHaveLength(1);
    const cheaper = quote({}, [
      session({ frozen: frozen({ rules: [{ ...SUNDAY_PLUS_20, value: '-10' }] }) }),
    ]);
    expect(amounts(cheaper)).toEqual([
      ['RENT', '100000'],
      ['ADJUSTMENT', '-10000'],
    ]);
  });

  it('an override replaces the rent, shown as the difference', () => {
    const r = quote({}, [
      session({
        frozen: frozen({
          rules: [
            {
              ...SUNDAY_PLUS_20,
              id: 'o1',
              name: 'Season price',
              adjustment: 'OVERRIDE',
              value: '150000',
            },
          ],
        }),
      }),
    ]);
    expect(amounts(r)).toEqual([
      ['RENT', '100000'],
      ['ADJUSTMENT', '50000'],
    ]);
    expect(r.grandTotal).toBe('150000');
  });
});

describe('step 2 and 3: package and add-ons', () => {
  const addOns = [
    { id: 'a1', name: 'Stage decor', pricing: 'FIXED' as const, price: '5000' },
    { id: 'a2', name: 'Soft drinks', pricing: 'PER_HEAD' as const, price: '100' },
    { id: 'a3', name: 'DJ', pricing: 'PER_HOUR' as const, price: '2000' },
    { id: 'a4', name: 'Chairs', pricing: 'PER_UNIT' as const, price: '300' },
  ];
  const pkg = { id: 'p1', name: 'Gold menu', perHeadRate: '1500', minGuests: 150 };

  it('the package is the per-head rate x billed guests (never below the minimum or the guarantee)', () => {
    const base = (guests: number, guaranteed: number | null) =>
      quote({}, [
        session({ guests, guaranteedGuests: guaranteed, frozen: frozen({ package: pkg }) }),
      ]).lines.find((l) => l.kind === 'PACKAGE');
    expect(base(200, null)).toMatchObject({ quantity: '200', unitPrice: '1500', amount: '300000' });
    expect(base(100, null)).toMatchObject({ quantity: '150', amount: '225000' }); // package minimum
    expect(base(100, 180)).toMatchObject({ quantity: '180', amount: '270000' }); // guaranteed guests
    expect(base(300, 180)).toMatchObject({ quantity: '300', amount: '450000' });
    expect(base(300, 180)?.refId).toBe('p1');
  });

  it('guests below the guarantee do not reduce the bill', () => {
    const at = (guests: number) =>
      quote({}, [session({ guests, guaranteedGuests: 200, frozen: frozen({ package: pkg }) })])
        .grandTotal;
    expect(at(120)).toBe(at(200));
    expect(Number(at(250))).toBeGreaterThan(Number(at(200)));
  });

  it('add-ons: FIXED, PER_HEAD (billed guests), PER_HOUR (session hours), PER_UNIT (chosen quantity)', () => {
    const r = quote({}, [
      session({
        guests: 100,
        guaranteedGuests: 250,
        addOnQuantities: { a1: 9, a2: 9, a3: 9, a4: 3 },
        frozen: frozen({ addOns }),
      }),
    ]);
    const byRef = Object.fromEntries(
      r.lines.filter((l) => l.kind === 'ADD_ON').map((l) => [l.refId, l]),
    );
    expect(byRef.a1).toMatchObject({ quantity: '1', amount: '5000' }); // the quantity is ignored
    expect(byRef.a2).toMatchObject({ quantity: '250', amount: '25000' }); // billed guests, not 100
    expect(byRef.a3).toMatchObject({ quantity: '4.5', amount: '9000' });
    expect(byRef.a4).toMatchObject({ quantity: '3', amount: '900' });
  });

  it('addOnQuantity is the single place the pricings are defined', () => {
    expect(addOnQuantity('FIXED', 100, '3', 7).toString()).toBe('1');
    expect(addOnQuantity('PER_HEAD', 100, '3', 7).toString()).toBe('100');
    expect(addOnQuantity('PER_HOUR', 100, '3.5', 7).toString()).toBe('3.5');
    expect(addOnQuantity('PER_UNIT', 100, '3', 7).toString()).toBe('7');
  });

  it('lines come in order: rent, adjustments, package, add-ons, per session', () => {
    const r = quote({}, [
      session({
        frozen: frozen({ rules: [SUNDAY_PLUS_20], package: pkg, addOns: addOns.slice(0, 1) }),
      }),
    ]);
    expect(r.lines.map((l) => l.kind)).toEqual(['RENT', 'ADJUSTMENT', 'PACKAGE', 'ADD_ON']);
    expect(r.lines.map((l) => l.sortOrder)).toEqual([0, 1, 2, 3]);
  });
});

describe('several sessions', () => {
  it('each session has its own lines and subtotal; the totals add them up', () => {
    const r = quote({}, [
      session({ index: 0, label: 'Mehndi', frozen: frozen({ unitRent: '80000' }) }),
      session({
        index: 1,
        label: 'Barat',
        guests: 300,
        frozen: frozen({
          rules: [SUNDAY_PLUS_20],
          package: { id: 'p1', name: 'Gold', perHeadRate: '1500', minGuests: 0 },
        }),
      }),
    ]);
    expect(r.sessions).toEqual([
      { index: 0, billedGuests: 200, subtotal: '80000' },
      { index: 1, billedGuests: 300, subtotal: '570000' }, // 100000 + 20000 + 450000
    ]);
    expect(r.subtotal).toBe('650000');
    expect(r.grandTotal).toBe('650000');
    expect(r.lines.filter((l) => l.sessionIndex === 1).map((l) => l.kind)).toEqual([
      'RENT',
      'ADJUSTMENT',
      'PACKAGE',
    ]);
  });
});

describe('step 4: discount', () => {
  const with200k = { sessions: [session({ frozen: frozen({ unitRent: '200000' }) })] };

  it('a percentage of the booking subtotal is a negative DISCOUNT line without a session', () => {
    const r = quote({ discount: { type: 'PERCENT', value: '5' } }, with200k.sessions);
    expect(r.lines.at(-1)).toMatchObject({
      kind: 'DISCOUNT',
      sessionIndex: null,
      amount: '-10000',
    });
    expect(r.discountTotal).toBe('-10000');
    expect(r.subtotal).toBe('200000');
    expect(r.grandTotal).toBe('190000');
  });

  it('an amount is subtracted as it is', () => {
    const r = quote({ discount: { type: 'AMOUNT', value: '15000' } }, with200k.sessions);
    expect(r.discountTotal).toBe('-15000');
    expect(r.grandTotal).toBe('185000');
  });

  it('the percentage is rounded half-up on the line', () => {
    const r = quote({ discount: { type: 'PERCENT', value: '5' }, maxDiscountPct: 5 }, [
      session({ frozen: frozen({ unitRent: '10.10' }) }),
    ]);
    expect(r.discountTotal).toBe('-0.51'); // 0.505 -> 0.51
  });

  it('is capped by the role: above the limit it is refused, at the limit it is fine', () => {
    expect(() =>
      quote(
        { discount: { type: 'PERCENT', value: '10.01' }, maxDiscountPct: 10 },
        with200k.sessions,
      ),
    ).toThrow(DiscountLimitExceededError);
    expect(() =>
      quote({ discount: { type: 'PERCENT', value: '10' }, maxDiscountPct: 10 }, with200k.sessions),
    ).not.toThrow();
    // An amount counts as the percentage of the subtotal it is.
    expect(() =>
      quote(
        { discount: { type: 'AMOUNT', value: '20001' }, maxDiscountPct: 10 },
        with200k.sessions,
      ),
    ).toThrow(DiscountLimitExceededError);
    expect(() =>
      quote(
        { discount: { type: 'AMOUNT', value: '20000' }, maxDiscountPct: 10 },
        with200k.sessions,
      ),
    ).not.toThrow();
  });

  it('a role without a limit (0) gives no discount at all; a zero discount is always fine', () => {
    expect(() =>
      quote({ discount: { type: 'PERCENT', value: '1' }, maxDiscountPct: 0 }, with200k.sessions),
    ).toThrow(DiscountLimitExceededError);
    expect(() =>
      quote({ discount: { type: 'PERCENT', value: '0' }, maxDiscountPct: 0 }, with200k.sessions),
    ).not.toThrow();
    const err = (() => {
      try {
        quote(
          { discount: { type: 'PERCENT', value: '7.5' }, maxDiscountPct: 5 },
          with200k.sessions,
        );
      } catch (e) {
        return e as DiscountLimitExceededError;
      }
    })();
    expect(err).toMatchObject({ limitPct: 5, requestedPct: '7.5' });
  });

  it('cannot be more than the subtotal', () => {
    expect(() =>
      quote(
        { discount: { type: 'AMOUNT', value: '200001' }, maxDiscountPct: 100 },
        with200k.sessions,
      ),
    ).toThrow(DiscountExceedsSubtotalError);
    const all = quote(
      { discount: { type: 'PERCENT', value: '100' }, maxDiscountPct: 100 },
      with200k.sessions,
    );
    expect(all.grandTotal).toBe('0');
  });
});

describe('step 5: tax', () => {
  const rentOnly = [session({ frozen: frozen({ unitRent: '100000' }) })];

  it('exclusive tax is added on the discounted subtotal as one TAX line', () => {
    const r = quote(
      {
        taxRate: { id: 't1', name: 'GST', ratePct: '16', inclusive: false },
        discount: { type: 'PERCENT', value: '10' },
      },
      rentOnly,
    );
    expect(amounts(r)).toEqual([
      ['RENT', '100000'],
      ['DISCOUNT', '-10000'],
      ['TAX', '14400'], // 16% of 90000
    ]);
    expect(r.taxTotal).toBe('14400');
    expect(r.grandTotal).toBe('104400');
    expect(r.lines.every((l) => l.taxAmount === '0')).toBe(true);
    expect(r.lines.at(-1)).toMatchObject({ refType: 'tax_rate', refId: 't1', sessionIndex: null });
  });

  it('no default tax rate, or a 0% one, means no TAX line', () => {
    expect(quote({}, rentOnly).lines.some((l) => l.kind === 'TAX')).toBe(false);
    expect(
      quote(
        { taxRate: { id: 't0', name: 'Exempt', ratePct: '0', inclusive: false } },
        rentOnly,
      ).lines.some((l) => l.kind === 'TAX'),
    ).toBe(false);
  });

  it('inclusive tax: lines are stored net, the TAX line is the contained tax, the total is what the customer pays', () => {
    const r = quote(
      { taxRate: { id: 't1', name: 'VAT', ratePct: '16', inclusive: true } },
      rentOnly,
    );
    // 100000 gross: tax = round(100000 x 16 / 116) = 13793.10, net = 86206.90
    expect(r.lines[0]).toMatchObject({ kind: 'RENT', amount: '86206.9', taxAmount: '13793.1' });
    expect(r.lines.at(-1)).toMatchObject({ kind: 'TAX', amount: '13793.1' });
    expect(r.grandTotal).toBe('100000');
    expect(money(r.lines[0]!.amount).plus(r.lines[0]!.taxAmount).toString()).toBe('100000'); // gross
  });

  it('inclusive tax with a discount: the discount is split the same way and the total is gross - discount', () => {
    const r = quote(
      {
        taxRate: { id: 't1', name: 'VAT', ratePct: '16', inclusive: true },
        discount: { type: 'PERCENT', value: '10' },
      },
      rentOnly,
    );
    expect(r.grandTotal).toBe('90000');
    const discount = r.lines.find((l) => l.kind === 'DISCOUNT')!;
    expect(money(discount.amount).plus(discount.taxAmount).toString()).toBe('-10000'); // gross -10000
    expect(r.taxTotal).toBe(
      sum(r.lines.filter((l) => l.kind !== 'TAX').map((l) => l.taxAmount)).toString(),
    );
  });

  it('inclusive tax, many awkward lines: net + tax = gross for every line and the total is exact', () => {
    const r = quote(
      {
        taxRate: { id: 't1', name: 'VAT', ratePct: '13.5', inclusive: true },
        discount: { type: 'AMOUNT', value: '777.77' },
        maxDiscountPct: 100,
      },
      [
        session({
          guests: 137,
          frozen: frozen({
            unitRent: '4999.99',
            rules: [{ ...SUNDAY_PLUS_20, value: '7.3' }],
            package: { id: 'p1', name: 'Menu', perHeadRate: '333.33', minGuests: 0 },
            addOns: [{ id: 'a1', name: 'Flowers', pricing: 'FIXED', price: '1234.56' }],
          }),
        }),
      ],
    );
    const gross = sum(
      r.lines
        .filter((l) => l.kind !== 'TAX')
        .map((l) => money(l.amount).plus(l.taxAmount).toString()),
    );
    expect(r.grandTotal).toBe(gross.toString());
    // The gross of the lines before the discount minus the discount.
    const before = sum(
      r.lines
        .filter((l) => l.kind !== 'TAX' && l.kind !== 'DISCOUNT')
        .map((l) => money(l.amount).plus(l.taxAmount).toString()),
    );
    expect(r.grandTotal).toBe(before.minus('777.77').toString());
    expect(money(r.taxTotal).gte(0)).toBe(true);
  });

  it('a full discount with inclusive tax never makes the TAX line negative', () => {
    for (const price of ['0.01', '0.03', '1.99', '12345.67', '99999.99']) {
      const r = quote(
        {
          taxRate: { id: 't1', name: 'VAT', ratePct: '16', inclusive: true },
          discount: { type: 'PERCENT', value: '100' },
          maxDiscountPct: 100,
        },
        [session({ frozen: frozen({ unitRent: price }) })],
      );
      expect(money(r.taxTotal).gte(0), price).toBe(true);
      expect(r.grandTotal, price).toBe('0');
    }
  });
});

describe('rounding per currency', () => {
  it('KWD has three decimals, JPY none', () => {
    const kwd = priceQuote({
      currency: 'KWD',
      sessions: [
        session({
          frozen: frozen({
            unitRent: '150.125',
            package: { id: 'p', name: 'M', perHeadRate: '2.3335', minGuests: 0 },
          }),
        }),
      ],
      taxRate: { id: 't', name: 'VAT', ratePct: '5', inclusive: false },
      discount: null,
      maxDiscountPct: 0,
    });
    expect(kwd.lines.find((l) => l.kind === 'PACKAGE')?.amount).toBe('466.7'); // 2.3335 x 200 = 466.70
    expect(kwd.lines.find((l) => l.kind === 'TAX')?.amount).toBe('30.841'); // 5% of 616.825 = 30.84125
  });

  it('JPY rounds to whole yen on each line', () => {
    const jpy = priceQuote({
      currency: 'JPY',
      sessions: [
        session({
          frozen: frozen({
            unitRent: '100000',
            package: { id: 'p', name: 'M', perHeadRate: '1234.5', minGuests: 0 },
          }),
        }),
      ],
      taxRate: { id: 't', name: 'Tax', ratePct: '10', inclusive: false },
      discount: null,
      maxDiscountPct: 0,
    });
    expect(jpy.lines.find((l) => l.kind === 'PACKAGE')?.amount).toBe('246900');
    expect(jpy.lines.find((l) => l.kind === 'TAX')?.amount).toBe('34690');
    expect(jpy.grandTotal).toBe('381590');
  });
});

describe('the sign convention and the sums', () => {
  it('every line obeys the database CHECK; the grand total is the sum of all lines', () => {
    const r = quote(
      {
        taxRate: { id: 't1', name: 'GST', ratePct: '16', inclusive: false },
        discount: { type: 'PERCENT', value: '5' },
      },
      [
        session({
          frozen: frozen({
            rules: [SUNDAY_PLUS_20, { ...SUNDAY_PLUS_20, id: 'r2', value: '-5', priority: 0 }],
            package: { id: 'p1', name: 'Gold', perHeadRate: '1500', minGuests: 0 },
            addOns: [{ id: 'a1', name: 'DJ', pricing: 'PER_HOUR', price: '2000' }],
          }),
        }),
      ],
    );
    for (const line of r.lines)
      expect(lineSignIsValid(line.kind, line.amount), line.description).toBe(true);
    expect(r.grandTotal).toBe(sum(r.lines.map((l) => l.amount)).toString());
    expect(money(r.subtotal).plus(r.discountTotal).plus(r.taxTotal).toString()).toBe(r.grandTotal);
  });

  it('lineSignIsValid mirrors docs/05', () => {
    expect(lineSignIsValid('DISCOUNT', '-1')).toBe(true);
    expect(lineSignIsValid('DISCOUNT', '1')).toBe(false);
    expect(lineSignIsValid('ADJUSTMENT', '-5')).toBe(true);
    expect(lineSignIsValid('ADJUSTMENT', '5')).toBe(true);
    for (const kind of ['RENT', 'PACKAGE', 'ADD_ON', 'TAX'] as const) {
      expect(lineSignIsValid(kind, '0')).toBe(true);
      expect(lineSignIsValid(kind, '-0.01')).toBe(false);
    }
  });

  it('is deterministic: the same input gives the same lines', () => {
    const input: QuoteInput = {
      currency: 'PKR',
      sessions: [session({ frozen: frozen({ rules: [SUNDAY_PLUS_20] }) })],
      taxRate: { id: 't', name: 'GST', ratePct: '16', inclusive: true },
      discount: { type: 'PERCENT', value: '3' },
      maxDiscountPct: 5,
    };
    expect(priceQuote(input)).toEqual(priceQuote(input));
  });
});
