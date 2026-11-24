import createClient from 'openapi-fetch';
import type { Client, Middleware } from 'openapi-fetch';
import type { paths } from './schema';

/** Header every state-changing request must carry (docs/04-security.md section 5, `CsrfGuard`). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'venueos';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Adds the CSRF header to every request that is not GET/HEAD/OPTIONS. */
export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      request.headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    }
    return request;
  },
};

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Same-origin path (`/api`) in the browser; an absolute URL on the server or in tests. */
  baseUrl: string;
  /** Replaceable in tests. Looked up per call, so a test may stub `globalThis.fetch` later. */
  fetch?: (request: Request) => Promise<Response>;
}

/**
 * The typed fetch client generated from the API's OpenAPI document. The browser talks to its own origin
 * (`/api/v1/...`, rewritten to the API); the session cookie travels with it and is never readable by script.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    credentials: 'same-origin',
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
  client.use(csrfMiddleware);
  return client;
}
