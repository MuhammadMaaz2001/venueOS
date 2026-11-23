import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

const HSTS = { maxAge: 31_536_000, includeSubDomains: true };
const REFERRER = { policy: 'strict-origin-when-cross-origin' } as const;

// The API serves JSON only, so the default policy is "nothing may load".
const apiHeaders = helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  hsts: HSTS,
  referrerPolicy: REFERRER,
  crossOriginResourcePolicy: { policy: 'same-origin' },
});

// Swagger UI needs its own scripts and styles. Only used for /docs, which is off in production.
const docsHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'none'"],
    },
  },
  hsts: HSTS,
  referrerPolicy: REFERRER,
});

function isDocsPath(path: string): boolean {
  return path === '/docs' || path.startsWith('/docs/') || path === '/docs-json';
}

const permissionsPolicy: RequestHandler = (_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
};

/** helmet headers (docs/04-security.md section 5) plus Permissions-Policy, which helmet does not set. */
export function securityHeaders(docsEnabled: boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const helmetHandler = docsEnabled && isDocsPath(req.path) ? docsHeaders : apiHeaders;
    helmetHandler(req, res, (err?: unknown) => {
      if (err) return next(err);
      permissionsPolicy(req, res, next);
    });
  };
}
