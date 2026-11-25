// Small date helpers that depend on a time zone (CLAUDE.md rule 5: never the server's local time). Pure `Intl`.

/** `Tue, 25 Nov 2026, 14:00` in `timeZone` (24 h, English): for staff emails. */
export function formatInstantForEmail(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** The calendar day (`YYYY-MM-DD`) it is at `instant` in `timeZone`. */
export function localDateIn(instant: Date, timeZone: string): string {
  // The `en-CA` locale formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
