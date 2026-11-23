import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FieldKeyring } from '@venueos/shared';

// AES-256-GCM sealing of secrets and sensitive fields (docs/04-security.md section 6).
//
// Sealed form: `v1.<keyId>.<iv>.<ciphertext>.<tag>`, each part base64url. The key id travels with the
// ciphertext, so keys rotate by adding a key and making it `active`; old keys keep opening old values.
//
// The caller passes AAD (additional authenticated data): the value is only valid together with it. For email
// secrets the AAD is `${tenantId}:${messageKey}`, so a sealed blob copied onto another row does not open.

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Any failure to seal or open. The message never contains key material, plaintext or the sealed value. */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export interface Sealer {
  seal(plaintext: string, aad: string): string;
  /** @throws SealError when the value is malformed, tampered with, sealed for other AAD, or its key is unknown */
  open(sealed: string, aad: string): string;
}

/**
 * Build a sealer from the keyring. Refuses (throws) when any key is not exactly 32 bytes of base64, so a
 * bad key stops the process at boot instead of failing later.
 */
export function createSealer(keyring: FieldKeyring): Sealer {
  const keys = new Map<string, Buffer>();
  for (const [id, material] of Object.entries(keyring.keys)) {
    const key = Buffer.from(material, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `FIELD_ENCRYPTION_KEYS: key "${id}" must be ${KEY_BYTES} bytes, base64-encoded`,
      );
    }
    keys.set(id, key);
  }
  const activeId = keyring.active;
  const active = keys.get(activeId);
  if (!active) throw new Error('FIELD_ENCRYPTION_KEYS: the active key is missing');

  return {
    seal(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', active, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, activeId, ...[iv, ciphertext, tag].map((b) => b.toString('base64url'))].join(
        '.',
      );
    },

    open(sealed, aad) {
      const parts = sealed.split('.');
      if (parts.length !== 5 || parts[0] !== VERSION) throw new SealError('Malformed sealed value');
      const [, keyId, ivPart, ctPart, tagPart] = parts as [string, string, string, string, string];
      const key = keys.get(keyId);
      if (!key) throw new SealError('Unknown encryption key');
      try {
        const iv = Buffer.from(ivPart, 'base64url');
        const tag = Buffer.from(tagPart, 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('bad lengths');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(ctPart, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // Wrong AAD, wrong key, tampering and garbage all look the same from outside.
        throw new SealError('Sealed value cannot be opened');
      }
    },
  };
}
