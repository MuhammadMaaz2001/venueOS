import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// The browser only ever talks to this origin. /api/* is forwarded to the API's internal URL, so
// the session cookie stays host-only (no CORS) and the API has no public listener
// (docs/02-system-design.md, "URLs and domains"). /api/v1/x -> API /v1/x, /api/health -> /health.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A self-contained server for the Docker image (apps/web/Dockerfile). The tracing root is the monorepo root, so
  // the workspace packages the app imports are traced into the output.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // The headers that do not depend on the request (the nonce-based CSP is set in src/proxy.ts).
  // docs/04-security.md section 5.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/:path*` }];
  },
};

// No /[locale] URL segment: the locale comes from a cookie (src/i18n/request.ts).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
