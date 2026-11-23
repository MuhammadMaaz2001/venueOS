import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// The browser only ever talks to this origin. /api/* is forwarded to the API's internal URL, so
// the session cookie stays host-only (no CORS) and the API has no public listener
// (docs/02-system-design.md, "URLs and domains"). /api/v1/x -> API /v1/x, /api/health -> /health.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/:path*` }];
  },
};

// No /[locale] URL segment: the locale comes from a cookie (src/i18n/request.ts).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
