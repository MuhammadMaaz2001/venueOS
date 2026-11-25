import { cancellationTierIssues } from '@venueos/shared';
import type { CancellationTier } from '@venueos/shared';

/** Display logic of the pricing screens (no business rules: the API decides, these only prepare what is shown). */

/** One row of the tier editor: what the person typed, as text. */
export interface TierRow {
  /** Stable key for React; never sent. */
  key: string;
  days: string;
  pct: string;
}

let rowCounter = 0;
export const newTierRow = (days = '', pct = ''): TierRow => ({
  key: `tier-${++rowCounter}`,
  days,
  pct,
});

export function rowsFromTiers(tiers: readonly CancellationTier[]): TierRow[] {
  return tiers.map((t) => newTierRow(String(t.minDaysBefore), String(t.refundPct)));
}

/** The rows as API tiers: whole days and a percentage; text that is not a number becomes NaN (the schema rejects it). */
export function tiersFromRows(rows: readonly TierRow[]): CancellationTier[] {
  return rows.map((r) => ({
    minDaysBefore: r.days.trim() === '' ? Number.NaN : Number(r.days),
    refundPct: r.pct.trim() === '' ? Number.NaN : Number(r.pct),
  }));
}

/** Rows ordered from the longest notice to the shortest, which is the order the API wants. Rows without a number stay last. */
export function sortRowsByDays(rows: readonly TierRow[]): TierRow[] {
  const days = (r: TierRow) => (r.days.trim() === '' ? Number.NEGATIVE_INFINITY : Number(r.days));
  return [...rows].sort((a, b) => days(b) - days(a));
}

export type TierProblem = 'incomplete' | 'order' | 'duplicate' | 'last' | 'empty';

/**
 * What is wrong with the rows, in words the editor translates. The same rule as the API (`cancellationTierIssues`);
 * this only tells the person early, which row to fix.
 */
export function tierProblem(rows: readonly TierRow[]): TierProblem | null {
  if (rows.length === 0) return 'empty';
  const tiers = tiersFromRows(rows);
  if (
    tiers.some(
      (t) => !Number.isInteger(t.minDaysBefore) || t.minDaysBefore < 0 || Number.isNaN(t.refundPct),
    )
  ) {
    return 'incomplete';
  }
  const issues = cancellationTierIssues(tiers);
  const first = issues[0];
  if (!first) return null;
  if (first.message.startsWith('Each')) return 'duplicate';
  if (first.message.startsWith('Order')) return 'order';
  return 'last';
}

/** A machine key for a custom field from its label: "Family name" -> "family_name". */
export function suggestFieldKey(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : slug === '' ? '' : `f_${slug}`.slice(0, 40);
}

/** The choices of a select field from a text box: one per line or comma, trimmed, no empties, no repeats (any case). */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const option = part.trim();
    if (option === '' || seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    out.push(option);
  }
  return out;
}

/** The effect of a rule as a signed text: `+20%`, `-5%`, `+5,000` (money formatted by the caller), `=150,000`. */
export function ruleEffect(
  adjustment: 'PERCENT' | 'FIXED_AMOUNT' | 'OVERRIDE',
  value: string,
  money: (v: string) => string,
): string {
  if (adjustment === 'OVERRIDE') return `= ${money(value)}`;
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const sign = negative ? '-' : '+';
  return adjustment === 'PERCENT' ? `${sign}${abs}%` : `${sign}${money(abs)}`;
}
