// Keys that must never reach a log line (docs/04-security.md section 6), plus the obvious variants
// that carry the same data. Matching is by key name at any depth up to MAX_DEPTH.
export const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'cookie',
  'set-cookie',
  'authorization',
  'cnic',
  'phone',
  'email',
  'body',
] as const;

const MAX_DEPTH = 5;
export const REDACT_CENSOR = '[REDACTED]';

function path(key: string, depth: number): string {
  const wildcards = Array<string>(depth).fill('*').join('.');
  // pino needs bracket syntax for keys that are not plain identifiers (set-cookie).
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return depth === 0 ? key : `${wildcards}.${key}`;
  return `${wildcards}["${key}"]`;
}

/** pino `redact.paths`: every key at the top level and under 1..MAX_DEPTH levels of nesting. */
export function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const key of REDACTED_KEYS) {
    for (let depth = 0; depth <= MAX_DEPTH; depth++) paths.push(path(key, depth));
  }
  return paths;
}
