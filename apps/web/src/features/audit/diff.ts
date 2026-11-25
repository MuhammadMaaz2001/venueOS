/**
 * The before/after of an audit entry as rows a person can read: one row per field (dotted path), what it was and
 * what it is now. Arrays of plain values (permission lists) show the items added and removed instead of two long
 * lists. Values are shown exactly as stored: secrets are already masked (`[REDACTED]`) by the API's audit writer.
 */

export type DiffKind = 'added' | 'removed' | 'changed' | 'same';

export interface DiffRow {
  path: string;
  kind: DiffKind;
  before: unknown;
  after: unknown;
  /** Only for two arrays of plain values that differ. */
  addedItems?: string[];
  removedItems?: string[];
}

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPlainList = (value: Json): value is (string | number | boolean | null)[] =>
  Array.isArray(value) &&
  value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

function walk(path: string, before: Json, after: Json, out: DiffRow[]): void {
  if (isRecord(before) || isRecord(after)) {
    // A key on one side only, or an object turned into something else, is walked key by key.
    const left = isRecord(before) ? before : {};
    const right = isRecord(after) ? after : {};
    if (
      (before !== undefined && before !== null && !isRecord(before)) ||
      (after !== undefined && after !== null && !isRecord(after))
    ) {
      out.push({ path, kind: 'changed', before, after });
      return;
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    for (const key of keys) walk(path ? `${path}.${key}` : key, left[key], right[key], out);
    return;
  }

  if (before === undefined && after === undefined) return;
  if (before === undefined) return void out.push({ path, kind: 'added', before, after });
  if (after === undefined) return void out.push({ path, kind: 'removed', before, after });
  if (same(before, after)) return void out.push({ path, kind: 'same', before, after });

  if (isPlainList(before) && isPlainList(after)) {
    const was = new Set(before.map(String));
    const now = new Set(after.map(String));
    out.push({
      path,
      kind: 'changed',
      before,
      after,
      addedItems: [...now].filter((v) => !was.has(v)),
      removedItems: [...was].filter((v) => !now.has(v)),
    });
    return;
  }
  out.push({ path, kind: 'changed', before, after });
}

/** Rows for every field of either side, in the order the fields appear (before first, then new ones). */
export function diffJson(before: Json, after: Json): DiffRow[] {
  const rows: DiffRow[] = [];
  // A missing side (create has no `before`, nothing has no `after`) is "nothing", not a value.
  walk('', before === null ? undefined : before, after === null ? undefined : after, rows);
  return rows;
}

/** A value as text: nothing is `—`, lists are comma separated, objects are compact JSON. */
export function formatDiffValue(value: Json): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (Array.isArray(value) && isPlainList(value))
    return value.length === 0 ? '[]' : value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
