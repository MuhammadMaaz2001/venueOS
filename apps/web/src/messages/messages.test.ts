import { ERROR_CODES } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/config';
import en from './en.json';

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

describe('messages (English-only MVP; the checks below also guard a language added later)', () => {
  it('every language of the app has a messages file with exactly the keys of English', async () => {
    for (const locale of LOCALES) {
      const messages = flatten((await import(`./${locale}.json`)).default as Tree);
      expect(Object.keys(messages).sort(), locale).toEqual(Object.keys(english).sort());
    }
  });

  it('every message is filled in', () => {
    for (const [key, message] of Object.entries(english)) {
      expect(message.trim(), `en ${key}`).not.toBe('');
    }
  });

  it('translates every error code of the API (and the browser-side NETWORK)', () => {
    for (const code of [...ERROR_CODES, 'NETWORK']) {
      expect(english[`Errors.${code}`], `en Errors.${code}`).toBeTruthy();
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
