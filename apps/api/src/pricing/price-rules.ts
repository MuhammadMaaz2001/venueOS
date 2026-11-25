import { money, roundMoney } from '@venueos/shared';
import type { AdjustmentKind, Money, MoneyInput, PriceRuleKind } from '@venueos/shared';

// Step 1 and 2 of docs/05-business-rules.md section 3 (base rent and price rules), as PURE functions: no Nest, no
// database, no clock. The rent preview (module 3) uses them today and the quotation engine (module 5) reuses them, so
// the preview always shows what a quotation will charge.
//
// The rules in short (decisions listed in .claude/plans/module-3.md):
//  - a rule matches when its scope (space, slot) and its date condition (weekday, season, specific day) fit;
//  - OVERRIDE: the highest priority wins and replaces the rent; matching overrides that lose are reported;
//  - then PERCENT and FIXED_AMOUNT rules apply highest priority first (ties: percent before fixed), each on the
//    running rent, each rounded half-up to the currency's minor unit on its own line;
//  - the rent never goes below 0;
//  - the effect of every applied rule is its own signed line (an `ADJUSTMENT` line of a quotation).

/** A price rule as the pricing code needs it. Dates are `YYYY-MM-DD`, `value` a decimal string. */
export interface PricingRule {
  id: string;
  name: string;
  kind: PriceRuleKind;
  /** null = every space. */
  spaceId: string | null;
  /** null = every slot. */
  slotId: string | null;
  daysOfWeek: readonly number[];
  startDate: string | null;
  endDate: string | null;
  adjustment: AdjustmentKind;
  value: string;
  priority: number;
}

/** What a rent is asked for: the space, slot and venue-local day of ONE session. */
export interface RuleContext {
  spaceId: string;
  slotId: string;
  /** `YYYY-MM-DD`, the event day in the venue's time zone. */
  date: string;
}

export interface AppliedRule {
  rule: PricingRule;
  /** Signed effect on the rent, rounded to the currency's minor unit. */
  amount: Money;
  /** The rent after this rule. */
  rentAfter: Money;
}

export interface RentResult {
  /** The rent before any rule, rounded. */
  baseRent: Money;
  /** In the order applied: the winning override first, then percent / fixed rules. */
  applied: AppliedRule[];
  /** Matching overrides that lost to a higher-priority one. */
  notApplied: PricingRule[];
  finalRent: Money;
}

/** 0 = Sunday .. 6 = Saturday of a calendar date (no time zone is involved: it is a date, not an instant). */
export function weekdayOf(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Not a date: ${JSON.stringify(date)}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

/** Does the rule apply to this space, slot and day? Inactive rules must be filtered out by the caller. */
export function ruleMatches(rule: PricingRule, context: RuleContext): boolean {
  if (rule.spaceId !== null && rule.spaceId !== context.spaceId) return false;
  if (rule.slotId !== null && rule.slotId !== context.slotId) return false;
  switch (rule.kind) {
    case 'DAY_OF_WEEK':
      return rule.daysOfWeek.includes(weekdayOf(context.date));
    case 'DATE_RANGE':
      return (
        rule.startDate !== null &&
        rule.endDate !== null &&
        rule.startDate <= context.date &&
        context.date <= rule.endDate
      );
    case 'SPECIFIC_DATE':
      return rule.startDate !== null && rule.startDate === context.date;
  }
}

const KIND_SPECIFICITY: Record<PriceRuleKind, number> = {
  SPECIFIC_DATE: 3,
  DATE_RANGE: 2,
  DAY_OF_WEEK: 1,
};

function scopeSpecificity(rule: PricingRule): number {
  return (rule.spaceId === null ? 0 : 1) + (rule.slotId === null ? 0 : 1);
}

/** Ties between rules of the same priority are broken the same way every time: nothing depends on row order. */
function compareTies(a: PricingRule, b: PricingRule): number {
  return (
    KIND_SPECIFICITY[b.kind] - KIND_SPECIFICITY[a.kind] ||
    scopeSpecificity(b) - scopeSpecificity(a) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Overrides: highest priority first. The first one wins. */
export function compareOverrides(a: PricingRule, b: PricingRule): number {
  return b.priority - a.priority || compareTies(a, b);
}

/** Percent and fixed rules: highest priority first; at the same priority a percentage comes before a fixed amount. */
export function compareAdjustments(a: PricingRule, b: PricingRule): number {
  const rank = (r: PricingRule) => (r.adjustment === 'PERCENT' ? 0 : 1);
  return b.priority - a.priority || rank(a) - rank(b) || compareTies(a, b);
}

/**
 * The base rent of a session: the rent of one slot, or for an HOURLY slot the rent per hour times the hours, rounded
 * half-up to the currency's minor unit (docs/05 section 3, step 1).
 */
export function baseRent(unitRent: MoneyInput, hours: MoneyInput | null, currency: string): Money {
  const unit = money(unitRent);
  return roundMoney(hours === null ? unit : unit.times(money(hours)), currency);
}

/** Apply the matching rules to a base rent (docs/05 section 3, step 2). */
export function applyPriceRules(input: {
  /** Already rounded (see `baseRent`). */
  baseRent: MoneyInput;
  currency: string;
  rules: readonly PricingRule[];
  context: RuleContext;
}): RentResult {
  const { currency, context } = input;
  const base = roundMoney(input.baseRent, currency);
  const matching = input.rules.filter((rule) => ruleMatches(rule, context));
  const overrides = matching.filter((r) => r.adjustment === 'OVERRIDE').sort(compareOverrides);
  const others = matching.filter((r) => r.adjustment !== 'OVERRIDE').sort(compareAdjustments);

  const applied: AppliedRule[] = [];
  let rent = base;
  const push = (rule: PricingRule, rawAmount: Money) => {
    // The rent never goes below 0: the line is cut so the lines still add up to the final rent.
    const amount = rent.plus(rawAmount).isNegative() ? rent.negated() : rawAmount;
    rent = rent.plus(amount);
    applied.push({ rule, amount, rentAfter: rent });
  };

  const [winner, ...losers] = overrides;
  if (winner) push(winner, roundMoney(winner.value, currency).minus(rent));
  for (const rule of others) {
    push(
      rule,
      rule.adjustment === 'PERCENT'
        ? roundMoney(rent.times(money(rule.value)).div(100), currency)
        : roundMoney(rule.value, currency),
    );
  }
  return { baseRent: base, applied, notApplied: losers, finalRent: rent };
}
