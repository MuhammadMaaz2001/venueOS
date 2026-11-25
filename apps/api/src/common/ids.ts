import { randomBytes } from 'node:crypto';

/**
 * A new row id of the same shape as Prisma's `cuid()` ids (25 lower-case characters, non-sequential). Used where the id
 * must be known BEFORE the row exists, e.g. to bind an encrypted value to its record (sealing AAD).
 */
export function newId(): string {
  return `c${randomBytes(12).toString('hex')}`;
}
