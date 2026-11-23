export const AUDIT_REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

// Compared against the key with case and separators removed ("password_hash" -> "passwordhash").
// Suffix match on purpose: "resetToken" and "apiKey" are secrets, "tokenAmount" (a tenant setting) is not.
const SECRET_SUFFIXES = [
  'password',
  'passwordhash',
  'secret',
  'token',
  'tokenhash',
  'apikey',
  'authorization',
  'cookie',
  'cnic',
  'credential',
  'credentials',
];
const PARTIAL_SUFFIXES = ['phone', 'email'];

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const endsWithAny = (key: string, suffixes: readonly string[]): boolean =>
  suffixes.some((s) => key.endsWith(s));

function maskPartial(key: string, value: unknown): string {
  if (typeof value !== 'string' || value.length < 4) return AUDIT_REDACTED;
  if (key.endsWith('email')) {
    const at = value.lastIndexOf('@');
    return at > 0 ? `${value[0]}***${value.slice(at)}` : AUDIT_REDACTED;
  }
  return `***${value.slice(-4)}`; // phone: last four characters only
}

/**
 * Copy of `value` that is safe to store in `audit_logs.before/after` (docs/04-security.md section 8):
 * secrets and credentials are replaced by `[REDACTED]`, phone numbers and emails keep only a hint, and
 * the result is plain JSON (dates as ISO strings, Decimals as strings). Recursive and depth-bounded.
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1) ?? null);

  const record = value as Record<string, unknown>;
  // Date, Decimal and friends know how to serialize themselves.
  if (typeof record.toJSON === 'function') {
    return maskSensitive((record.toJSON as () => unknown)(), depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(record)) {
    const key = normalize(rawKey);
    if (endsWithAny(key, SECRET_SUFFIXES)) {
      out[rawKey] = AUDIT_REDACTED;
    } else if (endsWithAny(key, PARTIAL_SUFFIXES)) {
      out[rawKey] = v === null || v === undefined ? null : maskPartial(key, v);
    } else {
      const masked = maskSensitive(v, depth + 1);
      if (masked !== undefined) out[rawKey] = masked;
    }
  }
  return out;
}
