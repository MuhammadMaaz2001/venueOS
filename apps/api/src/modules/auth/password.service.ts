import { randomBytes, timingSafeEqual, argon2 } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { FieldValidationError } from '../../common/errors/domain-errors';
import { BREACHED_PASSWORDS } from './data/breached-passwords';

// argon2id, stored as the standard PHC string `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`
// (unpadded base64). The P0-2 seed writes exactly this format with these parameters (docs/04 section 1).

/** Current parameters of every NEW hash. A stored hash with weaker ones is rehashed at the next login. */
export const ARGON2_PARAMS = { memory: 65_536, passes: 3, parallelism: 4, tagLength: 32 } as const;
const SALT_BYTES = 16;

// Hashes come from our own database, but cap what a (corrupt) value may ask of the process.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 16;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(phc: string): ParsedHash | undefined {
  const m = PHC.exec(phc);
  if (!m) return undefined;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  if (
    memory < 8 * parallelism ||
    memory > MAX_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM
  ) {
    return undefined;
  }
  return {
    memory,
    passes,
    parallelism,
    salt: Buffer.from(m[4] as string, 'base64'),
    hash: Buffer.from(m[5] as string, 'base64'),
  };
}

function derive(
  password: string,
  salt: Buffer,
  p: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        parallelism: p.parallelism,
        tagLength: p.tagLength,
        memory: p.memory,
        passes: p.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

@Injectable()
export class PasswordService implements OnModuleInit {
  /** A real hash of a random password: unknown emails are checked against it so timing does not tell. */
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(24).toString('base64url'));
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, ARGON2_PARAMS);
    const { memory, passes, parallelism } = ARGON2_PARAMS;
    return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  /** Recompute with the stored parameters and compare in constant time. False for anything malformed. */
  async verify(password: string, phc: string): Promise<boolean> {
    const parsed = parse(phc);
    if (!parsed || parsed.hash.length === 0) return false;
    const candidate = await derive(password, parsed.salt, {
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.hash.length,
    });
    return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  }

  /** Burn the same time as a real check (unknown email, locked account). Always false. */
  async verifyDummy(password: string): Promise<false> {
    if (this.dummyHash === '')
      this.dummyHash = await this.hash(randomBytes(24).toString('base64url'));
    await this.verify(password, this.dummyHash);
    return false;
  }

  /** True when the stored hash uses weaker parameters than a new hash would. */
  needsRehash(phc: string): boolean {
    const parsed = parse(phc);
    if (!parsed) return false;
    return (
      parsed.memory < ARGON2_PARAMS.memory ||
      parsed.passes < ARGON2_PARAMS.passes ||
      parsed.parallelism < ARGON2_PARAMS.parallelism
    );
  }
}

const BREACHED = new Set(BREACHED_PASSWORDS);

/**
 * Password policy beyond length (Zod checks 10 to 128 characters): reject the 10,000 most common passwords
 * (SecLists, see data/NOTICE.md). No composition rules (docs/04 section 1).
 *
 * @throws FieldValidationError 400 on the `password` field
 */
export function assertPasswordAllowed(password: string, field = 'password'): void {
  if (BREACHED.has(password) || BREACHED.has(password.toLowerCase())) {
    throw new FieldValidationError(field, 'This password is too common. Choose another one.');
  }
}
