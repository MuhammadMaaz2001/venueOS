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
