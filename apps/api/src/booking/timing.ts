import { FULL_DAY_END, FULL_DAY_START } from '@venueos/shared';
import type { LocalRules, SlotMode } from '@venueos/shared';
import { FieldValidationError } from '../common/errors/domain-errors';
import { addDays, daysBetween, localDateOf, localTimeOf, zonedInstant } from '../common/time/zoned';
import { durationMinutes, fitsOpeningHours } from '../modules/slot-templates/slot-times';

// Pure time arithmetic of a session (docs/05 sections 1 and 2): where a slot starts and ends on a calendar day of the
// venue's time zone, what the calendar blocks (buffers), and which local rules a session breaks.

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export interface SlotWindowInput {
  mode: SlotMode;
  /** The slot template's own times (FIXED: its shift; HOURLY: its window; FULL_DAY: 00:00-00:00). */
  startTime: string;
  endTime: string;
  minHours: number | null;
  /** The tenant's default minimum hours for an HOURLY slot. */
  defaultMinHours: number;
}

export interface SessionTimes {
  startsAt: Date;
  endsAt: Date;
  /** Length in hours, as a decimal string with at most 2 decimals (`"4.5"`). */
  hours: string;
  /** The venue-local times actually used. */
  startTime: string;
  endTime: string;
}

/**
 * The instants of a session on `date` (venue time zone). FIXED and FULL_DAY take the template's times (an end at or before
 * the start ends the next day; equal times are 24 hours); an HOURLY slot takes the requested `startTime` / `endTime`,
 * which must lie inside the template's window and last at least the minimum hours.
 */
export function sessionTimes(
  slot: SlotWindowInput,
  date: string,
  timeZone: string,
  requested: { startTime?: string | undefined; endTime?: string | undefined },
): SessionTimes {
  let startTime = slot.startTime;
  let endTime = slot.endTime;
  if (slot.mode === 'HOURLY') {
    startTime = requested.startTime ?? slot.startTime;
    endTime = requested.endTime ?? slot.endTime;
    const wholeDay = slot.startTime === FULL_DAY_START && slot.endTime === FULL_DAY_END;
    if (!wholeDay && !fitsOpeningHours(startTime, endTime, slot.startTime, slot.endTime)) {
      throw new FieldValidationError('startTime', 'The times must fall inside the slot’s window');
    }
    const minimum = slot.minHours ?? slot.defaultMinHours;
    if (durationMinutes(startTime, endTime) < minimum * 60) {
      throw new FieldValidationError('endTime', `An hourly booking is at least ${minimum} hours`);
    }
  } else if (requested.startTime !== undefined || requested.endTime !== undefined) {
    throw new FieldValidationError('startTime', 'Only an hourly slot has its own times');
  }
  const minutes = durationMinutes(startTime, endTime);
  const startsAt = zonedInstant(date, startTime, timeZone);
  // Wall-clock arithmetic on the calendar day keeps the end right across a daylight-saving change.
  const crossesMidnight = toMinutes(endTime) <= toMinutes(startTime);
  const endsAt = zonedInstant(crossesMidnight ? addDays(date, 1) : date, endTime, timeZone);
  return {
    startsAt,
    endsAt,
    hours: (Math.round((minutes / 60) * 100) / 100).toString(),
    startTime,
    endTime,
  };
}

/** What the calendar blocks for a session: the event range widened by the space's setup and cleanup buffers. */
export function occupancyRange(
  startsAt: Date,
  endsAt: Date,
  setupBufferMin: number,
  cleanupBufferMin: number,
): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(startsAt.getTime() - setupBufferMin * 60_000),
    endsAt: new Date(endsAt.getTime() + cleanupBufferMin * 60_000),
  };
}

export type LocalRuleBreach = 'LATEST_END_TIME' | 'MAX_GUESTS';

/**
 * The venue's local rules (docs/05 section 1: `latestEndTime`, `maxGuests`) a session breaks. `latestEndTime` is a clock time
 * of the day the session STARTS on; one that is not after the start's clock time means the next day (`02:00`).
 */
export function localRuleBreaches(
  rules: LocalRules,
  session: { startsAt: Date; endsAt: Date; guests: number },
  timeZone: string,
): LocalRuleBreach[] {
  const breaches: LocalRuleBreach[] = [];
  if (rules.maxGuests !== undefined && session.guests > rules.maxGuests)
    breaches.push('MAX_GUESTS');
  if (rules.latestEndTime !== undefined) {
    const startMin = toMinutes(localTimeOf(session.startsAt, timeZone));
    const latest = toMinutes(rules.latestEndTime);
    const latestAbs = latest <= startMin ? latest + 1440 : latest;
    const dayOffset = daysBetween(
      localDateOf(session.startsAt, timeZone),
      localDateOf(session.endsAt, timeZone),
    );
    const endAbs = dayOffset * 1440 + toMinutes(localTimeOf(session.endsAt, timeZone));
    if (endAbs > latestAbs) breaches.push('LATEST_END_TIME');
  }
  return breaches;
}
