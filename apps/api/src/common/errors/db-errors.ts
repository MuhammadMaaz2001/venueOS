import { SlotTakenError } from './domain-errors';
import type { AppError } from './domain-errors';

// SQLSTATE exclusion_violation. CLAUDE.md rule 7: the database decides double bookings; the API only
// translates the constraint error into 409 SLOT_TAKEN.
const EXCLUSION_VIOLATION = '23P01';
const OVERLAP_CONSTRAINT = 'space_occupancies_no_overlap';

/** Everything a driver / Prisma error chain says about itself, flattened (the shape varies by layer). */
function collectFacts(error: unknown): { codes: Set<string>; text: string } {
  const codes = new Set<string>();
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'originalCode', 'constraint', 'message', 'detail']) {
      const v = record[key];
      if (typeof v === 'string') {
        parts.push(v);
        if (key === 'code' || key === 'originalCode') codes.add(v);
      }
    }
    for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError'])
      visit(record[key], depth + 1);
  };
  visit(error, 0);
  return { codes, text: parts.join('\n') };
}

/** Returns the domain error for a known database constraint violation, else undefined. */
export function mapDatabaseError(error: unknown): AppError | undefined {
  const { codes, text } = collectFacts(error);
  if (
    text.includes(OVERLAP_CONSTRAINT) &&
    (codes.has(EXCLUSION_VIOLATION) || text.includes('exclusion constraint'))
  ) {
    return new SlotTakenError();
  }
  return undefined;
}

/** SQLSTATE unique_violation, or Prisma's P2002 for the same thing. */
export function isUniqueViolation(error: unknown): boolean {
  const { codes } = collectFacts(error);
  return codes.has('23505') || codes.has('P2002');
}
