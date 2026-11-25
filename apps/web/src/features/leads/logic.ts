import { LEAD_STAGES, OPEN_LEAD_STAGES, checkLeadStageChange, localDateIn } from '@venueos/shared';
import type { LeadStage } from '@venueos/shared';

// Display logic of the leads screens: stage lists, the follow-up state of a lead, and the conversion between a
// `datetime-local` box (wall clock, no zone) and an instant in the WORKSPACE time zone (never the browser's).

export { LEAD_STAGES, OPEN_LEAD_STAGES };

/** The stages of the board, left to right. */
export const BOARD_STAGES: readonly LeadStage[] = LEAD_STAGES;

/** Stages a lead can be moved to from `from` (what the move menu offers; the API decides again). */
export function reachableStages(from: LeadStage): LeadStage[] {
  return LEAD_STAGES.filter((to) => checkLeadStageChange(from, to).allowed);
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds. */
function offsetMs(timeZone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `2027-02-14T19:30` read as wall-clock time in `timeZone` -> ISO instant; `null` for anything else. */
export function localInputToInstant(value: string, timeZone: string): string | null {
  const m = LOCAL_INPUT.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(guess);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59)
    return null;
  let instant = guess - offsetMs(timeZone, guess);
  instant = guess - offsetMs(timeZone, instant);
  return new Date(instant).toISOString();
}

/** An instant as the value of a `datetime-local` box, in `timeZone`. */
export function instantToLocalInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** 10:00 on the day `days` days from today (workspace time zone): the follow-up presets. */
export function presetFollowUp(days: number, timeZone: string, now: Date = new Date()): string {
  const today = localDateIn(now, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return `${target}T10:00`;
}

export type FollowUpState = 'none' | 'overdue' | 'today' | 'later';

/** Where a follow-up stands: passed, later today, further away, or not applicable (closed lead). */
export function followUpState(
  nextFollowUpAt: string | null,
  now: Date,
  timeZone: string,
): FollowUpState {
  if (!nextFollowUpAt) return 'none';
  const at = new Date(nextFollowUpAt);
  if (at.getTime() < now.getTime()) return 'overdue';
  return localDateIn(at, timeZone) === localDateIn(now, timeZone) ? 'today' : 'later';
}
