/**
 * Mask an email address for logs: `ali.khan@example.com` -> `a***@example.com`. The domain is kept
 * (useful for debugging a provider), the local part is not. Anything that does not look like an
 * address becomes `***`.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/**
 * Mask a sensitive custom field value for display and for the stored hint (docs/04-security.md section 6):
 * `12345-1234567-1` -> `*****-*****67-1`. Letters and digits are replaced by `*`, separators stay, and only the last
 * few characters are kept: at most four, and never more than a third of the value, so a short value shows nothing.
 */
export function maskSensitiveValue(value: string): string {
  const chars = [...value];
  const keep = Math.min(4, Math.floor(chars.length / 3));
  const hidden = chars.length - keep;
  return chars.map((c, i) => (i < hidden && /[\p{L}\p{N}]/u.test(c) ? '*' : c)).join('');
}
