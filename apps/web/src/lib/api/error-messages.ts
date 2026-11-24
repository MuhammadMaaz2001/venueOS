import { ApiError } from './errors';
import type { ApiErrorCode } from './errors';

/**
 * Where the translated text of an API error comes from. `Errors.<CODE>` (one entry per code of
 * `ERROR_CODES`, enforced by a test) is the default; a call may name a more specific message for one code, e.g.
 * the staff page says "a workspace must keep one active Owner" for `INVALID_STATE_TRANSITION`.
 */
export type ErrorMessageOverrides = Partial<Record<ApiErrorCode, string>>;

/** Message keys of the `Errors` namespace for an error, honouring the caller's overrides (full keys). */
export function errorMessageKey(error: ApiError, overrides?: ErrorMessageOverrides): string {
  const override = overrides?.[error.code];
  if (override) return override;
  return `Errors.${error.code}`;
}
