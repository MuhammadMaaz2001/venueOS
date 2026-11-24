import { createApiClient } from '@venueos/api-client';

/**
 * The one API client of the web app. It talks to its own origin (`/api/v1/...`, rewritten by Next.js to the API's
 * internal URL, see next.config.ts), so the HttpOnly session cookie is host-only and no CORS is involved. The
 * client adds `X-Requested-With: venueos` to every request that changes state.
 *
 * Features never use it directly: they call it from their `features/<module>/api.ts` hooks.
 */
export const api = createApiClient({ baseUrl: '/api' });
