// Unit tests for AES-256-GCM sealing of secrets (no database needed).
// Run: pnpm --filter @venueos/db test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SealError, createSealer, openTemplateVars, sealedVarsAad } from '../src/index.js';

const key = () => randomBytes(32).toString('base64');
const ring = (active = 'k1', keys: Record<string, string> = { k1: key() }) => ({ active, keys });

describe('createSealer', () => {
  test('round-trips a value bound to its AAD', () => {
    const sealer = createSealer(ring());
    const sealed = sealer.seal('https://app.example.test/verify?token=abc', 't1:m1');
    assert.match(sealed, /^v1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes('token=abc'));
    assert.equal(sealer.open(sealed, 't1:m1'), 'https://app.example.test/verify?token=abc');
  });

  test('uses a fresh IV every time', () => {
    const sealer = createSealer(ring());
    assert.notEqual(sealer.seal('same', 'aad'), sealer.seal('same', 'aad'));
  });

  test('does not open for another AAD (a blob copied to another row)', () => {
    const sealer = createSealer(ring());
    const sealed = sealer.seal('secret', 'tenantA:message1');
    assert.throws(() => sealer.open(sealed, 'tenantA:message2'), SealError);
    assert.throws(() => sealer.open(sealed, 'tenantB:message1'), SealError);
  });

  test('does not open when any part was tampered with', () => {
    const sealer = createSealer(ring());
    const parts = sealer.seal('secret', 'aad').split('.');
    for (const i of [2, 3, 4]) {
      const copy = [...parts];
      const original = copy[i] as string;
      copy[i] = (original[0] === 'A' ? 'B' : 'A') + original.slice(1);
      assert.throws(() => sealer.open(copy.join('.'), 'aad'), SealError, `part ${i}`);
    }
    for (const bad of ['', 'v1.k1', 'v2.k1.a.b.c', 'v1.k1.a.b.c.d', 'garbage']) {
      assert.throws(() => sealer.open(bad, 'aad'), SealError, bad);
    }
  });

  test('rotates: a new active key seals, old keys still open old values', () => {
    const old = { k1: key() };
    const before = createSealer(ring('k1', old)).seal('old secret', 'aad');
    const rotated = createSealer(ring('k2', { ...old, k2: key() }));
    assert.match(rotated.seal('new secret', 'aad'), /^v1\.k2\./);
    assert.equal(rotated.open(before, 'aad'), 'old secret');
  });

  test('refuses a value sealed with a key it does not know', () => {
    const sealed = createSealer(ring('k1')).seal('x', 'aad');
    assert.throws(() => createSealer(ring('k9', { k9: key() })).open(sealed, 'aad'), /Unknown encryption key/);
  });

  test('refuses a key that is not 32 bytes at construction, without printing it', () => {
    const material = randomBytes(16).toString('base64');
    assert.throws(
      () => createSealer(ring('k1', { k1: material })),
      (error: Error) => /must be 32 bytes/.test(error.message) && !error.message.includes(material),
    );
  });

  test('errors never contain the plaintext or the sealed value', () => {
    const sealer = createSealer(ring());
    const sealed = sealer.seal('hunter2-secret', 'aad');
    try {
      sealer.open(sealed, 'other');
      assert.fail('should not open');
    } catch (error) {
      assert.ok(error instanceof SealError);
      assert.ok(!error.message.includes('hunter2'));
      assert.ok(!error.message.includes(sealed));
    }
  });
});

describe('openTemplateVars', () => {
  const sealer = createSealer(ring());
  const sealedFor = (tenantId: string, messageKey: string, secrets: object) =>
    sealer.seal(JSON.stringify(secrets), sealedVarsAad(tenantId, messageKey));

  test('merges the opened secrets into the plain variables', () => {
    const stored = { name: 'Ali', __sealed: sealedFor('t1', 'm1', { verifyUrl: 'https://x.test/?t=1' }) };
    assert.deepEqual(openTemplateVars(sealer, 't1', 'm1', stored), {
      name: 'Ali',
      verifyUrl: 'https://x.test/?t=1',
    });
  });

  test('plain variables without a sealed part pass through; nothing stored means no variables', () => {
    assert.deepEqual(openTemplateVars(sealer, 't1', 'm1', { a: 1 }), { a: 1 });
    assert.deepEqual(openTemplateVars(sealer, 't1', 'm1', null), {});
  });

  test('fails when the row is not the one the secrets were sealed for', () => {
    const stored = { __sealed: sealedFor('t1', 'm1', { token: 'x' }) };
    assert.throws(() => openTemplateVars(sealer, 't1', 'm2', stored), SealError);
    assert.throws(() => openTemplateVars(sealer, 't2', 'm1', stored), SealError);
  });

  test('fails on malformed stored data', () => {
    assert.throws(() => openTemplateVars(sealer, 't1', 'm1', 'text'), SealError);
    assert.throws(() => openTemplateVars(sealer, 't1', 'm1', { __sealed: 42 }), SealError);
    const notObject = sealer.seal('"just a string"', sealedVarsAad('t1', 'm1'));
    assert.throws(() => openTemplateVars(sealer, 't1', 'm1', { __sealed: notObject }), SealError);
    const notJson = sealer.seal('not json', sealedVarsAad('t1', 'm1'));
    assert.throws(() => openTemplateVars(sealer, 't1', 'm1', { __sealed: notJson }), SealError);
  });
});
