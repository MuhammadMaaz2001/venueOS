import { afterAll, describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '@venueos/shared';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';

describe('security middleware, throttling, swagger', () => {
  const apps: TestApp[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((t) => t.app.close()));
  });
  async function start(env?: Record<string, string>): Promise<TestApp> {
    const t = await createTestApp({ env });
    apps.push(t);
    return t;
  }

  it('sets the helmet headers and removes X-Powered-By', async () => {
    const t = await start();
    const res = await t.http().get('/v1/_probe/not-found');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  describe('throttler', () => {
    it('answers 429 RATE_LIMITED in the standard format after the limit', async () => {
      const t = await start({ THROTTLE_LIMIT: '3' });
      for (let i = 0; i < 3; i++) {
        expect((await t.http().get('/v1/_probe/not-found')).status).toBe(404);
      }
      const res = await t.http().get('/v1/_probe/not-found');
      expect(res.status).toBe(429);
      expect(ErrorResponseSchema.parse(res.body).error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('buckets by the client IP behind TRUST_PROXY=1', async () => {
      const t = await start({ THROTTLE_LIMIT: '2', TRUST_PROXY: '1' });
      const get = (ip: string) => t.http().get('/v1/_probe/not-found').set('X-Forwarded-For', ip);
      expect((await get('203.0.113.1')).status).toBe(404);
      expect((await get('203.0.113.1')).status).toBe(404);
      expect((await get('203.0.113.1')).status).toBe(429);
      // A different client is not affected.
      expect((await get('203.0.113.2')).status).toBe(404);
    });

    it('ignores X-Forwarded-For when TRUST_PROXY=0, so a spoofed header cannot dodge the limit', async () => {
      const t = await start({ THROTTLE_LIMIT: '2', TRUST_PROXY: '0' });
      const get = (ip: string) => t.http().get('/v1/_probe/not-found').set('X-Forwarded-For', ip);
      expect((await get('203.0.113.1')).status).toBe(404);
      expect((await get('203.0.113.2')).status).toBe(404);
      expect((await get('203.0.113.3')).status).toBe(429); // all share the real socket address
    });
  });

  describe('swagger', () => {
    it('serves /docs and the OpenAPI document outside production', async () => {
      const t = await start();
      const ui = await t.http().get('/docs');
      expect(ui.status).toBe(200);
      // Swagger UI needs inline script/style; the API-wide policy would break it.
      expect(ui.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
      const json = await t.http().get('/docs-json');
      expect(json.status).toBe(200);
      expect(json.body.paths['/health']).toBeDefined();
      expect(json.body.paths['/health/ready']).toBeDefined();
      expect(json.body.paths['/v1/health']).toBeUndefined();
    });

    it('is disabled in production unless SWAGGER_ENABLED is set', async () => {
      const off = await start({ NODE_ENV: 'production' });
      expect((await off.http().get('/docs')).status).toBe(404);
      expect((await off.http().get('/docs-json')).status).toBe(404);
      const on = await start({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' });
      expect((await on.http().get('/docs-json')).status).toBe(200);
    });
  });
});
