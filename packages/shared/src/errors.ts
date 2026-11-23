import { z } from 'zod';

/**
 * Stable machine codes of the API error format (docs/06-api-conventions.md, "Errors"). The web app
 * maps a code to translated text, so a code never changes meaning; add new ones, do not rename.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'PLAN_LIMIT_REACHED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'DISCOUNT_LIMIT',
  'TENANT_SUSPENDED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'SLOT_TAKEN',
  'VERSION_CONFLICT',
  'DUPLICATE',
  'IDEMPOTENCY_CONFLICT',
  'ADVANCE_REQUIRED',
  'LOCAL_RULE',
  'INSUFFICIENT_STOCK',
  'INVALID_STATE_TRANSITION',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** `{ error: { code, message, details?, requestId } }`, the only error body the API returns. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    /** User-safe English. Never contains stack traces, SQL or internal identifiers. */
    message: z.string(),
    /** Field errors for VALIDATION_ERROR, structured context for domain errors. */
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
