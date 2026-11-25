import { FULL_DAY_END, FULL_DAY_START } from '@venueos/shared';
import type { SlotMode } from '@venueos/shared';
import { FieldValidationError } from '../../common/errors/domain-errors';

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Length of a venue-local range in minutes; an end at or before the start ends the next day (equal = 24 h). */
export function durationMinutes(start: string, end: string): number {
  const diff = (toMinutes(end) - toMinutes(start) + 1440) % 1440;
  return diff === 0 ? 1440 : diff;
}

/** Does `start`..`end` fit inside the opening hours `opens`..`closes` (docs/05 section 1; both may cross midnight)? */
export function fitsOpeningHours(
  start: string,
  end: string,
  opens: string,
  closes: string,
): boolean {
  const window = durationMinutes(opens, closes);
  const offset = (toMinutes(start) - toMinutes(opens) + 1440) % 1440;
  return offset + durationMinutes(start, end) <= window;
}

export interface SlotTimesInput {
  mode: SlotMode;
  startTime?: string | undefined;
  endTime?: string | undefined;
  minHours?: number | null | undefined;
}

export interface VenueHours {
  opensAt: string | null;
  closesAt: string | null;
}

/**
 * The clock times a slot template is stored with (docs/05 section 1):
 *  - FIXED: the times given (an end earlier than the start ends the next day);
 *  - HOURLY: the window of the booking range, defaulting to the venue's opening hours (no hours = all day),
 *    which must fit inside them, and at least `minHours` long;
 *  - FULL_DAY: the whole day, stored as `00:00`-`00:00`.
 */
export function resolveSlotTimes(
  input: SlotTimesInput,
  venue: VenueHours,
): { startTime: string; endTime: string } {
  if (input.mode === 'FULL_DAY') return { startTime: FULL_DAY_START, endTime: FULL_DAY_END };

  if (input.mode === 'FIXED') {
    const startTime = input.startTime;
    const endTime = input.endTime;
    if (startTime === undefined) throw new FieldValidationError('startTime', 'Required');
    if (endTime === undefined) throw new FieldValidationError('endTime', 'Required');
    if (startTime === endTime) {
      throw new FieldValidationError('endTime', 'Start and end must differ');
    }
    return { startTime, endTime };
  }

  const startTime = input.startTime ?? venue.opensAt ?? FULL_DAY_START;
  const endTime = input.endTime ?? venue.closesAt ?? FULL_DAY_END;
  if (
    venue.opensAt !== null &&
    venue.closesAt !== null &&
    !fitsOpeningHours(startTime, endTime, venue.opensAt, venue.closesAt)
  ) {
    throw new FieldValidationError(
      'startTime',
      `Hourly slots must fall within the venue's opening hours (${venue.opensAt}-${venue.closesAt})`,
    );
  }
  if (input.minHours != null && durationMinutes(startTime, endTime) < input.minHours * 60) {
    throw new FieldValidationError('minHours', 'The minimum is longer than the slot window');
  }
  return { startTime, endTime };
}
