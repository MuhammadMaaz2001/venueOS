import { money, roundMoney } from '@venueos/shared';

export { clearedNet } from '@venueos/shared';
export type { LedgerRow } from '@venueos/shared';

// Cancellation and money rules that need no database (docs/05 sections 5 and 6).

export interface CancellationTier {
  minDaysBefore: number;
  refundPct: number;
}

/** The tier that applies `daysBefore` the first session: the first (longest notice) whose minimum is met. */
export function applicableTier(
  tiers: readonly CancellationTier[],
  daysBefore: number,
): CancellationTier | null {
  const sorted = [...tiers].sort((a, b) => b.minDaysBefore - a.minDaysBefore);
  return sorted.find((t) => daysBefore >= t.minDaysBefore) ?? null;
}

export interface RefundSuggestion {
  daysBefore: number;
  refundPct: number;
  /** Cleared receipts the suggestion is a share of. */
  received: string;
  /** `received x refundPct%`, rounded half-up to the currency's minor unit. */
  suggested: string;
}

/**
 * The refund the policy snapshot suggests (docs/05 section 6): the percentage of the tier that applies `daysBefore` the first
 * session, of what the customer has paid (cleared net receipts). No tier (a policy without a 0-day tier) means 0%.
 * The accountant can change it with a reason; refunds themselves are module 9.
 */
export function suggestRefund(
  tiers: readonly CancellationTier[],
  daysBefore: number,
  received: string,
  currency: string,
): RefundSuggestion {
  const pct = applicableTier(tiers, daysBefore)?.refundPct ?? 0;
  const base = money(received).lt(0) ? money('0') : money(received);
  return {
    daysBefore,
    refundPct: pct,
    received: base.toString(),
    suggested: roundMoney(base.times(String(pct)).div(100), currency).toString(),
  };
}

/** The advance a booking needs to be confirmed: `advancePct` percent of the grand total (not rounded: compared exactly). */
export function requiredAdvance(grandTotal: string, advancePct: number): string {
  return money(grandTotal).times(String(advancePct)).div(100).toString();
}

/** Has the customer paid at least the required advance? A zero total needs nothing. */
export function advanceMet(received: string, grandTotal: string, advancePct: number): boolean {
  return money(received).gte(requiredAdvance(grandTotal, advancePct));
}
