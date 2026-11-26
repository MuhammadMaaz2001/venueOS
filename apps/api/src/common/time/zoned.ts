/**
 * Calendar days of an IANA time zone as UTC instants (CLAUDE.md rule 5: never the server's local time).
 * Used where an API takes a date-only filter (`from=2027-02-14`) that means "that day in the workspace's zone".
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of `timeZone` from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetMs(timeZone: string, instantMs: number): number {
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

/** `YYYY-MM-DD` parsed and checked to be a real calendar day; null otherwise. */
export function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return real ? { year, month, day } : null;
}

/** The instant a calendar day starts in `timeZone` (00:00 local; a day without midnight starts at its first instant). */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const parsed = parseDateOnly(date);
  if (!parsed) throw new RangeError(`Invalid date: ${date}`);
  const guess = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  // The offset depends on the instant, which depends on the offset: two rounds settle every real zone.
  let instant = guess - offsetMs(timeZone, guess);
  instant = guess - offsetMs(timeZone, instant);
  return new Date(instant);
}

/** The instant the day AFTER `date` starts in `timeZone`: an exclusive upper bound for "up to and including `date`". */
export function startOfNextLocalDay(date: string, timeZone: string): Date {
  const parsed = parseDateOnly(date);
  if (!parsed) throw new RangeError(`Invalid date: ${date}`);
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  return startOfLocalDay(next.toISOString().slice(0, 10), timeZone);
}

/** The instant a wall-clock `HH:mm` of the calendar day `date` happens in `timeZone` (`24:00` is not valid: use the next day). */
export function zonedInstant(date: string, hhmm: string, timeZone: string): Date {
  const parsed = parseDateOnly(date);
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!parsed || !time) throw new RangeError(`Invalid date or time: ${date} ${hhmm}`);
  const guess = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    Number(time[1]),
    Number(time[2]),
  );
  let instant = guess - offsetMs(timeZone, guess);
  instant = guess - offsetMs(timeZone, instant);
  return new Date(instant);
}

/** `date` plus `days` calendar days (`YYYY-MM-DD`). */
export function addDays(date: string, days: number): string {
  const parsed = parseDateOnly(date);
  if (!parsed) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
    .toISOString()
    .slice(0, 10);
}

/** Whole calendar days from `from` to `to` (`YYYY-MM-DD`), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  if (!a || !b) throw new RangeError('Invalid date');
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** The calendar day an instant falls on in `timeZone` (`YYYY-MM-DD`). */
export function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The clock time (`HH:mm`, 24 h) of an instant in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}
