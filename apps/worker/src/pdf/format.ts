/** `1234567.5` -> `1,234,567.50` (the money strings of the database layer already have the currency's decimals). */
export const group = (value: string): string => {
  const [whole = '', fraction] = value.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
};

/** `Sat, 20 Mar 2027` of an instant in a time zone. */
export const date = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(instant);

/** `19:00` of an instant in a time zone. */
export const time = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
