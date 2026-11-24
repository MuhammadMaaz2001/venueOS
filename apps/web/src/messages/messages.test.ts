import { ERROR_CODES } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import ur from './ur.json';

interface Tree {
  [key: string]: string | Tree;
}

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const english = flatten(en as Tree);
const urdu = flatten(ur as Tree);

/** `{name}`, `{count, plural, ...}` -> the argument names a message needs. */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{(\w+)(?:,|\})/g)) names.add(match[1] as string);
  return [...names].sort();
}

describe('messages', () => {
  it('Urdu has exactly the keys English has', () => {
    expect(Object.keys(urdu).sort()).toEqual(Object.keys(english).sort());
  });

  it('every message is filled in, and both languages use the same placeholders', () => {
    for (const [key, message] of Object.entries(english)) {
      expect(message.trim(), `en ${key}`).not.toBe('');
      expect(urdu[key]?.trim(), `ur ${key}`).not.toBe('');
      expect(placeholders(urdu[key] ?? ''), `placeholders of ${key}`).toEqual(
        placeholders(message),
      );
    }
  });

  it('translates every error code of the API (and the browser-side NETWORK)', () => {
    for (const code of [...ERROR_CODES, 'NETWORK']) {
      expect(english[`Errors.${code}`], `en Errors.${code}`).toBeTruthy();
      expect(urdu[`Errors.${code}`], `ur Errors.${code}`).toBeTruthy();
    }
  });

  it('has the staff context messages the error mapping points at', () => {
    for (const key of [
      'Staff.errors.lastOwner',
      'Staff.errors.cannotManage',
      'Staff.errors.changedByOthers',
      'Staff.errors.duplicateInvite',
      'Staff.errors.cannotInvite',
      'Staff.errors.planLimit',
      'Staff.errors.alreadyAccepted',
    ]) {
      expect(english[key], key).toBeTruthy();
    }
  });
});
