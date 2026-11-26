import type { PaymentDto, RefundRequestDto, ScheduleItemDto } from '@venueos/shared';

// Display logic of the payment screens: which buttons an entry can show, exact sums of money strings, and how a schedule edit
// is checked before it is sent. The API decides again (and the database guards the ledger); nothing here prices anything.

export const MANUAL_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'MOBILE_WALLET'] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];

/** A cheque is identified by its number: the form asks for it. */
export const needsReference = (method: string): boolean => method === 'CHEQUE';

/** Decimals of an API money string (`"1500.00"` -> 2). */
const decimalsOf = (value: string): number => value.split('.')[1]?.length ?? 0;

/** A money string as an integer count of the smallest unit (`"12.50"` at 2 decimals -> 1250n). */
function scaled(value: string, decimals: number): bigint {
  const negative = value.trim().startsWith('-');
  const [whole = '0', fraction = ''] = value.trim().replace('-', '').split('.');
  const n = BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0').slice(0, decimals)}`);
  return negative ? -n : n;
}

function unscaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Sum of money strings in integer arithmetic (never a float); `decimals` is the currency's. */
export function sumAmounts(values: readonly string[], decimals?: number): string {
  const places = decimals ?? Math.max(0, ...values.map(decimalsOf));
  return unscaled(
    values.reduce((sum, v) => sum + scaled(v === '' ? '0' : v, places), 0n),
    places,
  );
}

/** Is the money string a positive amount with at most `decimals` places? */
export function isPositiveAmount(value: string, decimals: number): boolean {
  if (!/^\d{1,15}(\.\d+)?$/.test(value.trim())) return false;
  if (decimalsOf(value.trim()) > decimals) return false;
  return scaled(value.trim(), decimals) > 0n;
}

export interface ScheduleDraftRow {
  label: string;
  dueDate: string;
  amount: string;
}

export type ScheduleProblem = 'EMPTY' | 'ROW' | 'TOTAL';

/**
 * Checks an edited schedule the way the API will: at least one item, every item named, dated and above zero, and the items
 * adding up to the grand total exactly. Returns the first problem, or `null`.
 */
export function checkSchedule(
  rows: readonly ScheduleDraftRow[],
  grandTotal: string,
  decimals: number,
): { problem: ScheduleProblem; row?: number } | null {
  if (rows.length === 0) return { problem: 'EMPTY' };
  for (const [i, row] of rows.entries()) {
    if (
      row.label.trim() === '' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) ||
      !isPositiveAmount(row.amount, decimals)
    ) {
      return { problem: 'ROW', row: i };
    }
  }
  if (
    sumAmounts(
      rows.map((r) => r.amount),
      decimals,
    ) !== sumAmounts([grandTotal], decimals)
  )
    return { problem: 'TOTAL' };
  return null;
}

/** What is left to put on the last row so the schedule adds up (can be negative: too much). */
export function scheduleGap(
  rows: readonly ScheduleDraftRow[],
  grandTotal: string,
  decimals: number,
): string {
  return sumAmounts(
    [grandTotal, ...rows.map((r) => `-${r.amount.trim() === '' ? '0' : r.amount.trim()}`)],
    decimals,
  );
}

/** An entry that can still be cleared: a pending cheque (a received one or a refund cheque). */
export const canClear = (p: PaymentDto): boolean =>
  p.method === 'CHEQUE' && p.status === 'PENDING' && p.entryType !== 'REVERSAL';

/** A received cheque that is pending or cleared and not reversed can come back from the bank. */
export const canBounce = (p: PaymentDto): boolean =>
  p.method === 'CHEQUE' &&
  p.entryType === 'RECEIPT' &&
  p.status !== 'BOUNCED' &&
  p.reversedById === null;

/** Only a cleared receipt that was not reversed can be reversed. */
export const canReverse = (p: PaymentDto): boolean =>
  p.entryType === 'RECEIPT' && p.status === 'CLEARED' && p.reversedById === null;

/** An entry's effect on what the customer has paid: `+` a receipt, `-` a refund, `±` a reversal (undoes its target). */
export function effectOf(p: PaymentDto, byId: ReadonlyMap<string, PaymentDto>): '+' | '-' {
  if (p.entryType === 'RECEIPT') return '+';
  if (p.entryType === 'REFUND') return '-';
  return byId.get(p.reversesId ?? '')?.entryType === 'REFUND' ? '+' : '-';
}

export type Tone = 'success' | 'warning' | 'danger' | 'muted';

export function scheduleTone(status: ScheduleItemDto['status']): Tone {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'PARTLY':
      return 'warning';
    case 'OVERDUE':
      return 'danger';
    case 'UNPAID':
      return 'muted';
  }
}

export function paymentTone(status: PaymentDto['status']): Tone {
  return status === 'CLEARED' ? 'success' : status === 'PENDING' ? 'warning' : 'danger';
}

export function refundTone(status: RefundRequestDto['status']): Tone {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'APPROVED':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    case 'REQUESTED':
      return 'muted';
  }
}

/** What the refund queue offers for a request, from its status and who is asking. */
export function refundActions(
  r: Pick<RefundRequestDto, 'status' | 'requestedById'>,
  me: { userId: string; canApprove: boolean; canPay: boolean },
): { approve: boolean; reject: boolean; pay: boolean; ownRequest: boolean } {
  return {
    approve: r.status === 'REQUESTED' && me.canApprove,
    reject: r.status === 'REQUESTED' && me.canApprove,
    pay: r.status === 'APPROVED' && me.canPay,
    ownRequest: r.requestedById === me.userId,
  };
}
