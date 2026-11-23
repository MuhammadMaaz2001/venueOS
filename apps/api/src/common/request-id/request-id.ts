import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// A client-supplied id is only trusted if it is short and made of safe characters; anything else
// is replaced, so a caller cannot inject newlines or huge values into logs and error bodies.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.-]{8,64}$/;

export const REQUEST_ID_HEADER = 'X-Request-Id';

export type RequestWithId = Request & { id?: string };

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : `req_${randomUUID()}`;
}

/** Runs first: sets `req.id`, echoes it on the response, so errors from any later stage carry it. */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  req.id = resolveRequestId(req.headers['x-request-id']);
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
}
