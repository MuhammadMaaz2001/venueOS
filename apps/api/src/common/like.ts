/**
 * Prepares a search term for Prisma's `contains`, which hands the term to `ILIKE` as it is (and does not honour a
 * backslash escape): an unescaped `%` would match every row. `%` and `\` are removed; `_` (one-character wildcard) is
 * harmless in a search box and stays, so `ali_khan@x.com` still finds itself. Returns `null` when nothing is left (the
 * caller then matches nothing).
 */
export function searchTerm(raw: string): string | null {
  const cleaned = raw.replace(/[%\\]/g, '').trim();
  return cleaned === '' ? null : cleaned;
}
