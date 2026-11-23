import type { ErrorCode } from '@venueos/shared';

/**
 * Base of every error the API raises on purpose. `message` must be user-safe English (no SQL, ids of
 * other tenants, stack traces); the web app translates by `code`. The exception filter turns any
 * AppError into the docs/06-api-conventions.md error body.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class SessionExpiredError extends AppError {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(401, 'SESSION_EXPIRED', message);
  }
}

export class PlanLimitReachedError extends AppError {
  constructor(message = 'Your plan limit has been reached.', details?: unknown) {
    super(402, 'PLAN_LIMIT_REACHED', message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.', details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}

export class CsrfRejectedError extends AppError {
  constructor() {
    super(403, 'CSRF_REJECTED', 'The request was rejected for security reasons.');
  }
}

export class TenantSuspendedError extends AppError {
  constructor(message = 'This account is suspended and read-only.') {
    super(403, 'TENANT_SUSPENDED', message);
  }
}

/** Also used for another tenant's resource: the API never reveals that it exists elsewhere. */
export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class SlotTakenError extends AppError {
  constructor(message = 'That space is already booked for this time.', details?: unknown) {
    super(409, 'SLOT_TAKEN', message, details);
  }
}

export class VersionConflictError extends AppError {
  constructor(message = 'This record was changed by someone else. Reload and try again.') {
    super(409, 'VERSION_CONFLICT', message);
  }
}

export class DuplicateError extends AppError {
  constructor(message = 'This record already exists.', details?: unknown) {
    super(409, 'DUPLICATE', message, details);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'This Idempotency-Key was already used with a different request.') {
    super(409, 'IDEMPOTENCY_CONFLICT', message);
  }
}

export class InsufficientStockError extends AppError {
  constructor(message = 'Not enough stock for this movement.', details?: unknown) {
    super(422, 'INSUFFICIENT_STOCK', message, details);
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(message = 'This action is not allowed in the current state.', details?: unknown) {
    super(422, 'INVALID_STATE_TRANSITION', message, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'The request could not be understood.', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

/** A 400 VALIDATION_ERROR raised by the server (a rule Zod cannot express, e.g. a breached password). */
export class FieldValidationError extends AppError {
  constructor(path: string, message: string) {
    super(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path, code: 'custom', message }]);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many attempts. Please try again later.',
    /** Sent as the `Retry-After` header. */
    readonly retryAfterSeconds = 900,
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}
