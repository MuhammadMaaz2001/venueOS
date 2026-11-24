import { ErrorResponseSchema } from '@venueos/shared';
import type { ErrorCode } from '@venueos/shared';

/** The API's codes plus one the browser makes up when the request never reached the API. */
export type ApiErrorCode = ErrorCode | 'NETWORK';

/** One entry of `details` of a `VALIDATION_ERROR` (path of the field, the Zod code, English text). */
export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Every failed call becomes one of these: the stable machine `code` (the web app translates it, the English
 * `message` of the API is never shown), the HTTP status and the `requestId` to quote in a bug report.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** `details.reason` of a 403 (login with an unverified address, ...), when present. */
  get reason(): string | undefined {
    const details = this.details;
    if (typeof details === 'object' && details !== null && 'reason' in details) {
      const { reason } = details as { reason: unknown };
      return typeof reason === 'string' ? reason : undefined;
    }
    return undefined;
  }

  /** Field problems of a `VALIDATION_ERROR`; empty for every other code. */
  get fieldIssues(): FieldIssue[] {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return [];
    return this.details.filter(
      (issue): issue is FieldIssue =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as FieldIssue).path === 'string' &&
        typeof (issue as FieldIssue).code === 'string',
    );
  }

  /** The session is gone: the web app sends the user to the login page. */
  get isSessionProblem(): boolean {
    return this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_EXPIRED';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Build an ApiError from a response body that follows `{ error: { code, message, details, requestId } }`. */
export function apiErrorFrom(body: unknown, status: number): ApiError {
  const parsed = ErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details, requestId } = parsed.data.error;
    return new ApiError(code, status, message, details, requestId);
  }
  // A proxy error page or an unknown shape: never show it, treat it as an internal error.
  return new ApiError('INTERNAL', status, 'Unexpected response');
}

/** The shape openapi-fetch returns for every call. */
interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Await an openapi-fetch call and return its data, or throw an `ApiError`. A call that never reached the API
 * (offline, DNS, the API down behind the proxy) becomes `NETWORK`.
 */
export async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await call;
  } catch (cause) {
    throw new ApiError('NETWORK', 0, cause instanceof Error ? cause.message : 'Network error');
  }
  if (result.error !== undefined || !result.response.ok) {
    throw apiErrorFrom(result.error, result.response.status);
  }
  // 204 No Content has no body: the caller's T is `undefined` then.
  return result.data as T;
}
