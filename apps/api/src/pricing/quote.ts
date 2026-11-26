import { money, roundMoney } from '@venueos/shared';
import type { AddOnPricing, Money } from '@venueos/shared';
import { z } from 'zod';
import { applyPriceRules, baseRent } from './price-rules';
import type { PricingRule } from './price-rules';

// The whole of docs/05-business-rules.md section 3, as PURE functions (no Nest, no database, no clock):
//
//   per session   1. rent (+ price rules, `price-rules.ts`)        -> RENT line + one ADJUSTMENT line per rule applied
//                 2. package = per-head rate x billed guests        -> PACKAGE line
//                 3. add-ons (FIXED / PER_HEAD / PER_HOUR / PER_UNIT) -> ADD_ON lines
//   per booking   4. discount on the subtotal, capped by the role   -> DISCOUNT line (negative)
//                 5. tax on the discounted subtotal                 -> TAX line
//
// billed guests = max(guests, package minimum, guaranteed guests). Every line is rounded half-up to the currency's minor unit
// on its own; the totals are SUMS of the rounded lines, and the grand total is SUM(amount) of all lines. Signs follow the
// database CHECK: DISCOUNT <= 0, ADJUSTMENT +/-, everything else >= 0.
//
// Tax. Exclusive: tax = round(taxable x rate / 100), one TAX line, the other lines unchanged. Inclusive: the prices the customer
// sees are gross. Each line is split `tax = round(gross x rate / (100 + rate))`, `net = gross - tax` (net is never rounded on
// its own), the discount is split the same way, and the lines are stored NET with the contained tax in `taxAmount`; the TAX line
// is the sum of the contained taxes. So `SUM(amount)` equals what the customer pays, to the cent.

/** The prices a session was quoted with: frozen in `booking_sessions.pricing` (docs/05 section 4). */
export const FrozenSessionPricingSchema = z.object({
  /** Rent per slot (FIXED / FULL_DAY) or per hour (HOURLY). */
  unitRent: z.string(),
  /** Hours of an HOURLY slot (the rent is unit x hours); `null` for the other modes. */
  rentHours: z.string().nullable(),
  /** Price rules that matched the space and slot (the date is checked by the engine). */
  rules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(['DAY_OF_WEEK', 'DATE_RANGE', 'SPECIFIC_DATE']),
      spaceId: z.string().nullable(),
      slotId: z.string().nullable(),
      daysOfWeek: z.array(z.number().int()),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      adjustment: z.enum(['PERCENT', 'FIXED_AMOUNT', 'OVERRIDE']),
      value: z.string(),
      priority: z.number().int(),
    }),
  ),
  package: z
    .object({
      id: z.string(),
      name: z.string(),
      perHeadRate: z.string(),
      minGuests: z.number().int(),
    })
    .nullable(),
  addOns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      pricing: z.enum(['FIXED', 'PER_HEAD', 'PER_HOUR', 'PER_UNIT']),
      price: z.string(),
    }),
  ),
});
export type FrozenSessionPricing = z.infer<typeof FrozenSessionPricingSchema>;

export interface QuoteSessionInput {
  /** Position in the quotation; lines refer to it. */
  index: number;
  /** Shown in descriptions: `Barat, Hall A, Dinner, 14 Feb 2027`. */
  label: string;
  /** Event day in the venue's time zone (`YYYY-MM-DD`): the date price rules are matched against. */
  date: string;
  spaceId: string;
  slotId: string;
  /** Length of the session in hours (decimal string); used by PER_HOUR add-ons. */
  hours: string;
  guests: number;
  guaranteedGuests: number | null;
  /** Quantity chosen per add-on id (PER_UNIT uses it; the other pricings ignore it). */
  addOnQuantities: Readonly<Record<string, number>>;
  frozen: FrozenSessionPricing;
}

export interface QuoteTaxRate {
  id: string;
  name: string;
  /** Decimal string, e.g. `"16"`. */
  ratePct: string;
  inclusive: boolean;
}

export type QuoteDiscount = { type: 'PERCENT' | 'AMOUNT'; value: string };

export interface QuoteInput {
  currency: string;
  sessions: readonly QuoteSessionInput[];
  taxRate: QuoteTaxRate | null;
  discount: QuoteDiscount | null;
  /** The caller role's limit (`roles.limits.maxDiscountPct`); a role without one gives no discount. */
  maxDiscountPct: number;
}

export type QuoteLineKind = 'RENT' | 'PACKAGE' | 'ADD_ON' | 'ADJUSTMENT' | 'DISCOUNT' | 'TAX';

export interface QuoteLine {
  /** `null` for the discount and tax lines of the whole booking. */
  sessionIndex: number | null;
  kind: QuoteLineKind;
  description: string;
  refType: 'price_rule' | 'package' | 'add_on' | 'tax_rate' | null;
  refId: string | null;
  quantity: string;
  /** Signed like `amount`. */
  unitPrice: string;
  /** Signed; NET of tax with inclusive tax. */
  amount: string;
  /** The tax inside an inclusive line (signed like the line); `"0"` otherwise. */
  taxAmount: string;
  sortOrder: number;
}

export interface QuoteSessionResult {
  index: number;
  billedGuests: number;
  /** Sum of the session's own lines (net of tax, before the discount). */
  subtotal: string;
}

export interface QuoteResult {
  lines: QuoteLine[];
  sessions: QuoteSessionResult[];
  /** Sum of the lines that are neither DISCOUNT nor TAX. */
  subtotal: string;
  /** Sum of the DISCOUNT lines (zero or negative). */
  discountTotal: string;
  /** Sum of the TAX lines. */
  taxTotal: string;
  /** Sum of every line: what the customer pays. */
  grandTotal: string;
}

/** The discount is more than the role may give. The API answers 403 `DISCOUNT_LIMIT`. */
export class DiscountLimitExceededError extends Error {
  constructor(
    readonly limitPct: number,
    readonly requestedPct: string,
  ) {
    super('DISCOUNT_LIMIT');
    this.name = 'DiscountLimitExceededError';
  }
}

/** The discount is more than there is to discount. The API answers 400 on `discount`. */
export class DiscountExceedsSubtotalError extends Error {
  constructor() {
    super('DISCOUNT_EXCEEDS_SUBTOTAL');
    this.name = 'DiscountExceedsSubtotalError';
  }
}

/** Guests the per-head lines are billed on: `max(guests, package minimum, guaranteed)`. */
export function billedGuests(
  guests: number,
  packageMinGuests: number | null | undefined,
  guaranteedGuests: number | null | undefined,
): number {
  return Math.max(guests, packageMinGuests ?? 0, guaranteedGuests ?? 0);
}

const ZERO = money('0');

/** `gross x rate / (100 + rate)`, rounded half-up: the tax contained in an inclusive amount (sign-symmetric). */
function containedTax(gross: Money, ratePct: Money, currency: string): Money {
  if (gross.isZero()) return ZERO;
  return roundMoney(gross.times(ratePct).div(ratePct.plus(100)), currency);
}

interface RawLine {
  sessionIndex: number | null;
  kind: QuoteLineKind;
  description: string;
  refType: QuoteLine['refType'];
  refId: string | null;
  quantity: Money;
  unitPrice: Money;
  amount: Money;
}

function ruleDescription(rule: PricingRule): string {
  return rule.adjustment === 'PERCENT'
    ? `${rule.name} (${money(rule.value).toString()}%)`
    : rule.name;
}

/** Price a quotation. Pure and deterministic: the same input always gives the same lines. */
export function priceQuote(input: QuoteInput): QuoteResult {
  const { currency } = input;
  const raw: RawLine[] = [];
  const sessionResults: { index: number; billedGuests: number; gross: Money }[] = [];

  for (const session of input.sessions) {
    const { frozen } = session;
    const lines: RawLine[] = [];
    const push = (line: Omit<RawLine, 'sessionIndex'>) =>
      lines.push({ ...line, sessionIndex: session.index });

    // 1. Rent and price rules.
    const base = baseRent(frozen.unitRent, frozen.rentHours, currency);
    const rules: PricingRule[] = frozen.rules.map((r) => ({ ...r }));
    const rent = applyPriceRules({
      baseRent: base,
      currency,
      rules,
      context: { spaceId: session.spaceId, slotId: session.slotId, date: session.date },
    });
    push({
      kind: 'RENT',
      description: `Rent: ${session.label}`,
      refType: null,
      refId: null,
      quantity: frozen.rentHours === null ? money('1') : money(frozen.rentHours),
      unitPrice: frozen.rentHours === null ? rent.baseRent : money(frozen.unitRent),
      amount: rent.baseRent,
    });
    for (const applied of rent.applied) {
      push({
        kind: 'ADJUSTMENT',
        description: ruleDescription(applied.rule),
        refType: 'price_rule',
        refId: applied.rule.id,
        quantity: money('1'),
        unitPrice: applied.amount,
        amount: applied.amount,
      });
    }

    // 2. Package: per-head rate x billed guests.
    const billed = billedGuests(
      session.guests,
      frozen.package?.minGuests,
      session.guaranteedGuests,
    );
    if (frozen.package) {
      const rate = money(frozen.package.perHeadRate);
      push({
        kind: 'PACKAGE',
        description: `${frozen.package.name}: ${billed} guests`,
        refType: 'package',
        refId: frozen.package.id,
        quantity: money(String(billed)),
        unitPrice: rate,
        amount: roundMoney(rate.times(billed), currency),
      });
    }

    // 3. Add-ons.
    for (const addOn of frozen.addOns) {
      const price = money(addOn.price);
      const chosen = session.addOnQuantities[addOn.id] ?? 1;
      const quantity = addOnQuantity(addOn.pricing, billed, session.hours, chosen);
      push({
        kind: 'ADD_ON',
        description: addOn.name,
        refType: 'add_on',
        refId: addOn.id,
        quantity,
        unitPrice: price,
        amount: roundMoney(price.times(quantity), currency),
      });
    }

    raw.push(...lines);
    sessionResults.push({
      index: session.index,
      billedGuests: billed,
      gross: lines.reduce((sum, l) => sum.plus(l.amount), ZERO),
    });
  }

  const subtotalGross = raw.reduce((sum, l) => sum.plus(l.amount), ZERO);

  // 4. Discount on the booking subtotal, within the role's limit.
  let discount = ZERO;
  if (input.discount) {
    const value = money(input.discount.value);
    discount =
      input.discount.type === 'PERCENT'
        ? roundMoney(subtotalGross.times(value).div(100), currency)
        : roundMoney(value, currency);
    const requestedPct =
      input.discount.type === 'PERCENT'
        ? value
        : subtotalGross.isZero()
          ? discount.isZero()
            ? ZERO
            : money('100')
          : discount.div(subtotalGross).times(100);
    if (discount.gt(subtotalGross)) throw new DiscountExceedsSubtotalError();
    if (requestedPct.gt(input.maxDiscountPct) && !discount.isZero()) {
      throw new DiscountLimitExceededError(
        input.maxDiscountPct,
        requestedPct.toDecimalPlaces(2).toString(),
      );
    }
  }

  // 5. Tax on the discounted subtotal.
  const rate = input.taxRate ? money(input.taxRate.ratePct) : ZERO;
  const taxed = input.taxRate !== null && rate.gt(0);
  const lines: QuoteLine[] = [];
  let order = 0;
  const finish = (l: RawLine, taxAmount: Money, amount: Money): QuoteLine => ({
    sessionIndex: l.sessionIndex,
    kind: l.kind,
    description: l.description,
    refType: l.refType,
    refId: l.refId,
    quantity: l.quantity.toString(),
    unitPrice: l.unitPrice.toString(),
    amount: amount.toString(),
    taxAmount: taxAmount.toString(),
    sortOrder: order++,
  });

  let linesTax = ZERO;
  const net = new Map<RawLine, { amount: Money; tax: Money; unit: Money }>();
  for (const line of raw) {
    if (taxed && input.taxRate?.inclusive) {
      const tax = containedTax(line.amount, rate, currency);
      const amount = line.amount.minus(tax);
      // A quantity-1 line shows the net; a multi-unit line shows the net per unit (display only).
      const unit = line.quantity.eq(1)
        ? amount
        : line.unitPrice.minus(containedTax(line.unitPrice, rate, currency));
      net.set(line, { amount, tax, unit });
      linesTax = linesTax.plus(tax);
    } else {
      net.set(line, { amount: line.amount, tax: ZERO, unit: line.unitPrice });
    }
  }
  for (const line of raw) {
    const n = net.get(line) as { amount: Money; tax: Money; unit: Money };
    lines.push(finish({ ...line, unitPrice: n.unit }, n.tax, n.amount));
  }

  let discountTax = ZERO;
  if (!discount.isZero()) {
    if (taxed && input.taxRate?.inclusive) {
      // Never more tax back than the lines carry, so the TAX line cannot go negative.
      discountTax = containedTax(discount, rate, currency);
      if (discountTax.gt(linesTax)) discountTax = linesTax;
    }
    const netDiscount = discount.minus(discountTax);
    lines.push(
      finish(
        {
          sessionIndex: null,
          kind: 'DISCOUNT',
          description:
            input.discount?.type === 'PERCENT'
              ? `Discount (${money(input.discount.value).toString()}%)`
              : 'Discount',
          refType: null,
          refId: null,
          quantity: money('1'),
          unitPrice: netDiscount.negated(),
          amount: netDiscount.negated(),
        },
        discountTax.negated(),
        netDiscount.negated(),
      ),
    );
  }

  if (taxed && input.taxRate) {
    const exclusiveBase = subtotalGross.minus(discount);
    const taxLine = input.taxRate.inclusive
      ? linesTax.minus(discountTax)
      : roundMoney(exclusiveBase.times(rate).div(100), currency);
    lines.push(
      finish(
        {
          sessionIndex: null,
          kind: 'TAX',
          description: `${input.taxRate.name} (${rate.toString()}%${input.taxRate.inclusive ? ', included' : ''})`,
          refType: 'tax_rate',
          refId: input.taxRate.id,
          quantity: money('1'),
          unitPrice: taxLine,
          amount: taxLine,
        },
        ZERO,
        taxLine,
      ),
    );
  }

  const sum = (pick: (l: QuoteLine) => boolean): Money =>
    lines.filter(pick).reduce((total, l) => total.plus(l.amount), ZERO);
  return {
    lines,
    sessions: sessionResults.map((s) => ({
      index: s.index,
      billedGuests: s.billedGuests,
      subtotal: lines
        .filter((l) => l.sessionIndex === s.index)
        .reduce((total, l) => total.plus(l.amount), ZERO)
        .toString(),
    })),
    subtotal: sum((l) => l.kind !== 'DISCOUNT' && l.kind !== 'TAX').toString(),
    discountTotal: sum((l) => l.kind === 'DISCOUNT').toString(),
    taxTotal: sum((l) => l.kind === 'TAX').toString(),
    grandTotal: sum(() => true).toString(),
  };
}

/** Quantity an add-on is billed on: 1 (FIXED), billed guests (PER_HEAD), session hours (PER_HOUR), chosen units (PER_UNIT). */
export function addOnQuantity(
  pricing: AddOnPricing,
  billed: number,
  hours: string,
  chosen: number,
): Money {
  switch (pricing) {
    case 'FIXED':
      return money('1');
    case 'PER_HEAD':
      return money(String(billed));
    case 'PER_HOUR':
      return money(hours);
    case 'PER_UNIT':
      return money(String(chosen));
  }
}

/** The sign rule of `booking_line_items` (docs/05 section 3): the database CHECK, as a function the tests use. */
export function lineSignIsValid(kind: QuoteLineKind, amount: string): boolean {
  const value = money(amount);
  if (kind === 'DISCOUNT') return value.lte(0);
  if (kind === 'ADJUSTMENT') return true;
  return value.gte(0);
}
