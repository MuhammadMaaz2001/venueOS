import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { hashEmail, hashToken, newToken } from '../modules/auth/auth.constants';
import { BREACHED_PASSWORDS } from '../modules/auth/data/breached-passwords';
import { PasswordService, assertPasswordAllowed } from '../modules/auth/password.service';
import { readSessionCookie } from '../modules/auth/session-cookie';

describe('breached password list', () => {
  it('is exactly the SecLists file next to it (regenerate with scripts/generate-breached-passwords.mjs)', () => {
    const lines = [
      ...new Set(
        readFileSync(join(__dirname, '../modules/auth/data/10k-most-common.txt'), 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.length > 0),
      ),
    ];
    expect(BREACHED_PASSWORDS).toEqual(lines);
    expect(lines.length).toBe(10_001);
  });

  it('records where it came from and under which licence', () => {
    const notice = readFileSync(join(__dirname, '../modules/auth/data/NOTICE.md'), 'utf8');
    expect(notice).toContain('913b327317496d062bcc7cace524aaad8a693be2');
    expect(notice).toContain('github.com/danielmiessler/SecLists');
    expect(notice).toContain('MIT');
  });

  it('rejects listed passwords in any letter case, and accepts others', () => {
    expect(() => assertPasswordAllowed('qwertyuiop')).toThrow('Some fields are invalid.');
    expect(() => assertPasswordAllowed('QWERTYUIOP')).toThrow('Some fields are invalid.');
    expect(() => assertPasswordAllowed('correct horse battery staple 42')).not.toThrow();
  });
});

describe('PasswordService', () => {
  const service = new PasswordService();

  it('writes the standard PHC string with the documented parameters, and verifies it', async () => {
    const phc = await service.hash('a long enough passphrase');
    expect(phc).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(await service.verify('a long enough passphrase', phc)).toBe(true);
    expect(await service.verify('another passphrase', phc)).toBe(false);
    expect(await service.hash('a long enough passphrase')).not.toBe(phc); // random salt
    expect(service.needsRehash(phc)).toBe(false);
  });

  it('refuses anything that is not a well-formed argon2id hash instead of throwing', async () => {
    for (const bad of [
      '',
      'plain text',
      '$argon2i$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaA',
      '$argon2id$v=19$m=999999999,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo',
      '$argon2id$v=19$m=65536,t=0,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo',
    ]) {
      expect(await service.verify('x', bad), bad).toBe(false);
      expect(service.needsRehash(bad)).toBe(false);
    }
  });

  it('flags weaker parameters for a rehash, one at a time', () => {
    const base = (m: number, t: number, p: number) =>
      `$argon2id$v=19$m=${m},t=${t},p=${p}$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo`;
    expect(service.needsRehash(base(65_536, 3, 4))).toBe(false);
    expect(service.needsRehash(base(131_072, 4, 8))).toBe(false); // stronger is fine
    expect(service.needsRehash(base(19_456, 3, 4))).toBe(true);
    expect(service.needsRehash(base(65_536, 2, 4))).toBe(true);
    expect(service.needsRehash(base(65_536, 3, 1))).toBe(true);
  });
});

describe('token and hash helpers', () => {
  it('tokens are 32 random bytes as base64url, and only their SHA-256 hash is derived', () => {
    const a = newToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(newToken());
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });

  it('email hashes ignore case and surrounding spaces', () => {
    expect(hashEmail('  Ali@Example.test ')).toBe(hashEmail('ali@example.test'));
    expect(hashEmail('ali@example.test')).not.toContain('ali');
  });
});

describe('readSessionCookie', () => {
  const req = (cookie?: string) => ({ headers: { cookie } }) as unknown as Request;

  it('finds the session cookie among others, with or without spaces', () => {
    expect(readSessionCookie(req('a=1; __Host-vos_session=TOKEN; b=2'))).toBe('TOKEN');
    expect(readSessionCookie(req('__Host-vos_session=TOKEN'))).toBe('TOKEN');
    expect(readSessionCookie(req('a=1;__Host-vos_session=TOKEN'))).toBe('TOKEN');
  });

  it('ignores a similarly named cookie, an empty value and a missing header', () => {
    expect(readSessionCookie(req('vos_session=TOKEN'))).toBeUndefined();
    expect(readSessionCookie(req('x__Host-vos_session=TOKEN'))).toBeUndefined();
    expect(readSessionCookie(req('__Host-vos_session='))).toBeUndefined();
    expect(readSessionCookie(req())).toBeUndefined();
  });

  it('takes the first value when the cookie is sent twice', () => {
    expect(readSessionCookie(req('__Host-vos_session=ONE; __Host-vos_session=TWO'))).toBe('ONE');
  });
});
