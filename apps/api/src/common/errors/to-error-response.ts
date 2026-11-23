import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '@venueos/shared';
import { ZodValidationException } from 'nestjs-zod';
import { mapDatabaseError } from './db-errors';
import { AppError } from './domain-errors';

export interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  /** True when the cause is unexpected: logged at error level with the original exception. */
  unexpected: boolean;
}

// Messages for errors that do not come from our own AppError classes. Fixed text on purpose: the
// message of a framework or driver exception can contain internals.
const STATUS_TABLE: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request could not be understood.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
  404: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'This method is not allowed on this resource.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
};

const FALLBACK_CLIENT_ERROR = {
  code: 'BAD_REQUEST',
  message: 'The request could not be understood.',
} as const;

const INTERNAL: MappedError = {
  status: 500,
  code: 'INTERNAL',
  message: 'Something went wrong. Please try again.',
  unexpected: true,
};

function httpStatusOf(exception: unknown): number | undefined {
  if (exception instanceof HttpException) return exception.getStatus();
  // Errors raised by Express middleware (body-parser: malformed JSON, payload too large).
  if (typeof exception === 'object' && exception !== null) {
    const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
    const value = typeof status === 'number' ? status : statusCode;
    if (typeof value === 'number' && value >= 400 && value < 500) return value;
  }
  return undefined;
}

/** Pure mapping from anything thrown to the API's error shape. No I/O, easy to unit-test. */
export function toErrorResponse(exception: unknown): MappedError {
  if (exception instanceof AppError) {
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      unexpected: false,
    };
  }

  if (exception instanceof ZodValidationException) {
    const zodError = exception.getZodError() as {
      issues?: { path: PropertyKey[]; code: string; message: string }[];
    };
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid.',
      // Field, rule and message only; never the submitted value.
      details: (zodError.issues ?? []).map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
      unexpected: false,
    };
  }

  const fromDatabase = mapDatabaseError(exception);
  if (fromDatabase) {
    return {
      status: fromDatabase.status,
      code: fromDatabase.code,
      message: fromDatabase.message,
      details: fromDatabase.details,
      unexpected: false,
    };
  }

  const status = httpStatusOf(exception);
  if (status !== undefined) {
    const entry = STATUS_TABLE[status] ?? FALLBACK_CLIENT_ERROR;
    return { status, code: entry.code, message: entry.message, unexpected: false };
  }

  return INTERNAL;
}
