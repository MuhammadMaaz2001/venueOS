import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ErrorResponse } from '@venueos/shared';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { REQUEST_ID_HEADER, resolveRequestId } from '../request-id/request-id';
import type { RequestWithId } from '../request-id/request-id';
import { RateLimitedError } from './domain-errors';
import { toErrorResponse } from './to-error-response';

/**
 * The one exception filter: every error leaves the API as `{ error: { code, message, details,
 * requestId } }` (docs/06-api-conventions.md). Unexpected errors are logged in full (with the
 * request id) and answered with a generic 500: no stack trace, SQL or internals in the response.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();

    // req.id is set by the first middleware; the fallback covers errors that bypass it.
    const requestId = req.id ?? resolveRequestId(undefined);
    const mapped = toErrorResponse(exception);

    if (mapped.unexpected) {
      this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    }

    const body: ErrorResponse = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
        requestId,
      },
    };

    if (res.headersSent) return;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (exception instanceof RateLimitedError) {
      res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    res.status(mapped.status).json(body);
  }
}
