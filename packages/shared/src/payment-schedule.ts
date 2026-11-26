import { formatMoney, money, roundMoney, sumMoney } from './money.js';

// The payment schedule of a booking (docs/05 section 5): how it is generated from the workspace settings, how received money
// is applied to it (FIFO, no allocation table) and what that says about each item. Pure: no database, no clock (the caller
// passes `today`), so the API, the reminder job and the tests share one implementation.

export const SCHEDULE_LABELS = ['Token', 'Advance', 'Balance'] as const;

export interface ScheduleItemDraft {
  label: string;
  /** Date-only `YYYY-MM-DD` in the workspace time zone. */
  dueDate: string;
  /** API money string with the currency's decimals. */
  amount: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `value` plus `days` (negative allowed), date-only arithmetic in UTC: no time zone can shift a day. */
export function addDays(value: string, days: number): string {
  const m = DATE.exec(value);
  if (!m) throw new RangeError(`Invalid date: ${value}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleInput {
  grandTotal: string;
  currency: string;
  /** From the workspace settings. */
  tokenAmount: string;
  advancePct: number;
  balanceDueDays: number;
  /** The day the schedule is made (the hold): the token is due then. */
  today: string;
  /** The last day of the hold: the advance is due by then (defaults to `today`). */
  advanceDue?: string | null;
  /** Date of the first active session (workspace time zone). */
  firstSessionDate: string | null;
}

/**
 * Token (a fixed amount), Advance (`advancePct` of the total, less the token already asked for) and Balance (the rest, due
 * `balanceDueDays` before the first session, never before the advance). Zero-amount items are left out; a zero total has no
 * schedule. Amounts are rounded to the currency's minor unit and add up to the total exactly (the Balance takes the rest).
 */
export function generateSchedule(input: ScheduleInput): ScheduleItemDraft[] {
  const { currency } = input;
  const total = roundMoney(input.grandTotal, currency);
  if (total.lte(0)) return [];
  const fmt = (v: { toString(): string }) => formatMoney(v.toString(), currency);

  let token = roundMoney(input.tokenAmount, currency);
  if (token.gt(total)) token = total;
  const advanceTotal = roundMoney(total.times(String(input.advancePct)).div(100), currency);
  let advance = advanceTotal.minus(token);
  if (advance.lt(0)) advance = money('0');
  const balance = total.minus(token).minus(advance);

  const tokenDue = input.today;
  const advanceDue = input.advanceDue && input.advanceDue > tokenDue ? input.advanceDue : tokenDue;
  let balanceDue = input.firstSessionDate
    ? addDays(input.firstSessionDate, -input.balanceDueDays)
    : advanceDue;
  if (balanceDue < advanceDue) balanceDue = advanceDue;

  const items: ScheduleItemDraft[] = [];
  if (token.gt(0)) items.push({ label: 'Token', dueDate: tokenDue, amount: fmt(token) });
  if (advance.gt(0)) items.push({ label: 'Advance', dueDate: advanceDue, amount: fmt(advance) });
  if (balance.gt(0)) items.push({ label: 'Balance', dueDate: balanceDue, amount: fmt(balance) });
  return items;
}

export type ScheduleStatus = 'PAID' | 'PARTLY' | 'UNPAID' | 'OVERDUE';

export interface ScheduleItemRow {
  id: string;
  dueDate: string;
  amount: string;
  /** Tie-break for items due the same day (creation order). */
  position: number;
}

export interface ScheduleItemState {
  id: string;
  allocated: string;
  remaining: string;
  status: ScheduleStatus;
}

export interface Allocation {
  items: ScheduleItemState[];
  /** Cleared net receipts (never below zero). */
  received: string;
  /** What is still owed on the schedule. */
  outstanding: string;
  /** Received money beyond the schedule (an overpayment): shown as credit, settled by a refund. */
  credit: string;
}

/**
 * Applies the cleared net receipts to the items in due-date order (FIFO). An item is PAID when fully covered, PARTLY when some
 * money reached it, otherwise UNPAID; an item with something still owed whose due date is before `today` is OVERDUE.
 */
export function allocateFifo(
  items: readonly ScheduleItemRow[],
  receivedNet: string,
  today: string,
): Allocation {
  let left = money(receivedNet);
  if (left.lt(0)) left = money('0');
  const received = left;
  const ordered = [...items].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.position - b.position,
  );
  const states = new Map<string, ScheduleItemState>();
  for (const item of ordered) {
    const amount = money(item.amount);
    const applied = left.gte(amount) ? amount : left;
    left = left.minus(applied);
    const remaining = amount.minus(applied);
    const status: ScheduleStatus = remaining.lte(0)
      ? 'PAID'
      : item.dueDate < today
        ? 'OVERDUE'
        : applied.gt(0)
          ? 'PARTLY'
          : 'UNPAID';
    states.set(item.id, {
      id: item.id,
      allocated: applied.toString(),
      remaining: remaining.toString(),
      status,
    });
  }
  const scheduled = sumMoney(items.map((i) => i.amount));
  const outstanding = scheduled.minus(received);
  return {
    items: items.map((i) => states.get(i.id) as ScheduleItemState),
    received: received.toString(),
    outstanding: (outstanding.gt(0) ? outstanding : money('0')).toString(),
    credit: (left.gt(0) ? left : money('0')).toString(),
  };
}

/** The items of an edited schedule must add up to the grand total (docs/05 section 5). */
export function scheduleMatchesTotal(
  items: readonly { amount: string }[],
  grandTotal: string,
): boolean {
  return sumMoney(items.map((i) => i.amount)).eq(money(grandTotal));
}

/** "Ready to confirm": the hold is open and the cleared receipts reach the advance (nothing confirms by itself). */
export function readyToConfirm(
  status: string,
  receivedNet: string,
  grandTotal: string,
  advancePct: number,
): boolean {
  return (
    status === 'TENTATIVE' &&
    money(receivedNet).gte(money(grandTotal).times(String(advancePct)).div(100))
  );
}
