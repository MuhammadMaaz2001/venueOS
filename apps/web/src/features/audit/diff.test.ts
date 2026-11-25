import { describe, expect, it } from 'vitest';
import { diffJson, formatDiffValue } from './diff';

describe('diffJson', () => {
  it('a create: every field is added', () => {
    const rows = diffJson(null, { name: 'Front desk', limits: { maxDiscountPct: 5 } });
    expect(rows).toEqual([
      { path: 'name', kind: 'added', before: undefined, after: 'Front desk' },
      { path: 'limits.maxDiscountPct', kind: 'added', before: undefined, after: 5 },
    ]);
  });

  it('an update: changed, same and removed fields, nested paths', () => {
    const rows = diffJson(
      { name: 'A', rev: 1, limits: { maxDiscountPct: 5 }, gone: 'x' },
      { name: 'B', rev: 1, limits: { maxDiscountPct: 7.5 } },
    );
    const by = Object.fromEntries(rows.map((r) => [r.path, r.kind]));
    expect(by).toEqual({
      name: 'changed',
      rev: 'same',
      'limits.maxDiscountPct': 'changed',
      gone: 'removed',
    });
  });

  it('lists of plain values show what was added and removed', () => {
    const [row] = diffJson({ permissions: ['a', 'b'] }, { permissions: ['b', 'c'] });
    expect(row).toMatchObject({ kind: 'changed', addedItems: ['c'], removedItems: ['a'] });
  });

  it('masked values are shown as stored and an equal pair is "same"', () => {
    const rows = diffJson({ password: '[REDACTED]' }, { password: '[REDACTED]' });
    expect(rows).toEqual([
      { path: 'password', kind: 'same', before: '[REDACTED]', after: '[REDACTED]' },
    ]);
    expect(formatDiffValue('[REDACTED]')).toBe('[REDACTED]');
  });

  it('nothing on both sides gives no rows; a scalar turned into an object is one change', () => {
    expect(diffJson(null, null)).toEqual([]);
    expect(diffJson({ a: 'x' }, { a: { b: 1 } })).toEqual([
      { path: 'a', kind: 'changed', before: 'x', after: { b: 1 } },
    ]);
  });

  it('formats values for display', () => {
    expect(formatDiffValue(null)).toBe('—');
    expect(formatDiffValue(undefined)).toBe('—');
    expect(formatDiffValue(['a', 'b'])).toBe('a, b');
    expect(formatDiffValue([])).toBe('[]');
    expect(formatDiffValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDiffValue(false)).toBe('false');
    expect(formatDiffValue('')).toBe('""');
  });
});
