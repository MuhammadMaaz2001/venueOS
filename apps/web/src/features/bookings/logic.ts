import { bookingTransition } from '@venueos/shared';
import type { AvailabilityCellDto, BookingStatus } from '@venueos/shared';

// Display logic of the calendar and the booking screens. Date-only values (`YYYY-MM-DD`) have no zone: they are computed
// in UTC arithmetic so the browser's zone never shifts a day. What the buttons offer is decided again by the API.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(value: string): Date {
  const m = DATE.exec(value);
  if (!m) throw new RangeError(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function shiftDate(value: string, days: number): string {
  const d = parse(value);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** 0 = Sunday, like the API's `daysOfWeek`. */
export function weekdayOf(value: string): number {
  return parse(value).getUTCDay();
}

/** The Monday of the week of `value`. */
export function startOfWeek(value: string): string {
  const day = weekdayOf(value);
  return shiftDate(value, day === 0 ? -6 : 1 - day);
}

export interface Range {
  from: string;
  to: string;
}

export function weekRange(value: string): Range {
  const from = startOfWeek(value);
  return { from, to: shiftDate(from, 6) };
}

/** First and last day of the month of `value`. */
export function monthRange(value: string): Range {
  const d = parse(value);
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: fmt(from), to: fmt(to) };
}

export function shiftMonth(value: string, months: number): string {
  const d = parse(value);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)));
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 400; day = shiftDate(day, 1)) out.push(day);
  return out;
}

/** The range the calendar loads for a view: the visible month or week. */
export function viewRange(view: 'month' | 'week', anchor: string): Range {
  return view === 'month' ? monthRange(anchor) : weekRange(anchor);
}

export const cellKey = (spaceId: string, date: string, slotId: string): string =>
  `${spaceId}|${date}|${slotId}`;

/** Taken cells by `cellKey`; any other cell of the grid is free. */
export function indexCells(
  cells: readonly AvailabilityCellDto[],
): Map<string, AvailabilityCellDto> {
  return new Map(cells.map((cell) => [cellKey(cell.spaceId, cell.date, cell.slotId), cell]));
}

/** Is the slot offered on that date (an empty list of weekdays = every day)? */
export function slotOffered(slot: { daysOfWeek: readonly number[] }, date: string): boolean {
  return slot.daysOfWeek.length === 0 || slot.daysOfWeek.includes(weekdayOf(date));
}

export interface HoldTimer {
  expired: boolean;
  /** Whole hours and minutes left (0 when expired). */
  hours: number;
  minutes: number;
}

export function holdTimer(holdExpiresAt: string, now: Date = new Date()): HoldTimer {
  const left = new Date(holdExpiresAt).getTime() - now.getTime();
  if (left <= 0) return { expired: true, hours: 0, minutes: 0 };
  const totalMinutes = Math.floor(left / 60_000);
  return { expired: false, hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export type StatusTone = 'neutral' | 'warning' | 'success' | 'danger' | 'muted';

export function statusTone(status: BookingStatus): StatusTone {
  switch (status) {
    case 'DRAFT':
      return 'muted';
    case 'TENTATIVE':
      return 'warning';
    case 'CONFIRMED':
    case 'COMPLETED':
      return 'success';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'danger';
  }
}

export type OfferedAction = 'hold' | 'extend-hold' | 'confirm' | 'cancel' | 'restore' | 'rehold';

/** Which buttons a booking in `status` can show. The API refuses the rest. */
export function offeredActions(status: BookingStatus, cancelledFromKnown = true): OfferedAction[] {
  const out: OfferedAction[] = [];
  if (bookingTransition(status, 'hold').allowed) out.push('hold');
  if (status === 'TENTATIVE') out.push('extend-hold');
  if (bookingTransition(status, 'confirm').allowed) out.push('confirm');
  if (bookingTransition(status, 'rehold').allowed) out.push('rehold');
  if (status === 'CANCELLED' && cancelledFromKnown) out.push('restore');
  if (bookingTransition(status, 'cancel').allowed) out.push('cancel');
  return out;
}

/** `Mehndi, Barat` from the distinct names, in order. */
export function joinDistinct(values: readonly (string | null)[]): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ''))].join(', ');
}

/** `a - b` of two API money strings with the same number of decimals, in integer arithmetic (never a float). */
export function subtract(a: string, b: string): string {
  const decimals = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const scale = (value: string): bigint => {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const n = BigInt(whole + fraction.padEnd(decimals, '0'));
    return negative ? -n : n;
  };
  const diff = scale(a) - scale(b);
  const negative = diff < 0n;
  const digits = (negative ? -diff : diff).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
