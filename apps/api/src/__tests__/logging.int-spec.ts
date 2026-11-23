import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';

// Every secret below is a unique literal so "it appears nowhere in the log output" is a precise check.
const SECRETS = [
  'pw-top-level',
  'nested@example.test',
  '+923001234567',
  '35202-1234567-1',
  'tok-in-array',
  'abc.def.ghi',
  'sess-secret',
  'cookie-secret',
  'body-secret',
  'hdr-bearer-secret',
  'hdr-cookie-secret',
  'query-email@example.test',
  'req-password-secret',
  'req-token-secret',
  'req-cnic-secret',
];

describe('logging', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { TRUST_PROXY: '1' } });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('writes one JSON access log per request with requestId, method, path, status and the client IP', async () => {
    await t
      .http()
      .get('/v1/_probe/not-found?email=query-email@example.test')
      .set('X-Request-Id', 'req-access-0001')
      .set('X-Forwarded-For', '203.0.113.7');

    const line = t
      .logLines()
      .find((l) => (l.req as { id?: string } | undefined)?.id === 'req-access-0001');
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      level: 40, // 4xx is a warning
      service: 'api',
      requestId: 'req-access-0001',
      req: {
        id: 'req-access-0001',
        method: 'GET',
        path: '/v1/_probe/not-found',
        ip: '203.0.113.7',
      },
      res: { statusCode: 404 },
    });
    expect(typeof line?.responseTime).toBe('number');
    // Query string, headers and bodies are never part of the line.
    expect(JSON.stringify(line)).not.toContain('query-email');
    expect(line?.req).not.toHaveProperty('headers');
  });

  it('adds tenantId and userId from the request context to every line of the request', async () => {
    await t.http().get('/v1/_probe/context').set('X-Request-Id', 'req-context-001');
    const lines = t.logLines().filter((l) => l.requestId === 'req-context-001');
    const inside = lines.find((l) => l.msg === 'inside request');
    expect(inside).toMatchObject({
      requestId: 'req-context-001',
      tenantId: 'tenant_probe',
      userId: 'user_probe',
    });
    const access = lines.find((l) => l.res);
    expect(access).toMatchObject({
      tenantId: 'tenant_probe',
      userId: 'user_probe',
      res: { statusCode: 200 },
    });
  });

  it('redacts sensitive fields: headers, query, bodies and nested log objects never reach the output', async () => {
    const res = await t
      .http()
      .post('/v1/_probe/log-sensitive?email=query-email@example.test')
      .set(t.csrfHeaders)
      .set('Authorization', 'Bearer hdr-bearer-secret')
      .set('Cookie', '__Host-vos_session=hdr-cookie-secret')
      .send({
        password: 'req-password-secret',
        token: 'req-token-secret',
        cnic: 'req-cnic-secret',
      });
    expect(res.status).toBe(201);

    const logged = t.logLines().find((l) => l.msg === 'probe log');
    expect(logged).toMatchObject({
      password: '[REDACTED]',
      user: { email: '[REDACTED]', profile: { phone: '[REDACTED]', cnic: '[REDACTED]' } },
      list: [{ token: '[REDACTED]' }],
      headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' },
      body: '[REDACTED]',
    });

    const output = t.rawLogs();
    for (const secret of SECRETS) {
      expect(output, `"${secret}" leaked into the logs`).not.toContain(secret);
    }
  });

  it('does not log request or response bodies on errors either', async () => {
    await t
      .http()
      .post('/v1/_probe/echo')
      .set(t.csrfHeaders)
      .send({ name: '', guests: 'req-password-secret' });
    expect(t.rawLogs()).not.toContain('req-password-secret');
  });

  it('logs unexpected errors with their stack, while the response stays generic', async () => {
    const res = await t.http().get('/v1/_probe/boom');
    expect(res.body.error.message).not.toContain('ECONNREFUSED');
    const error = t.logLines().find((l) => l.msg === 'Unhandled exception');
    expect(error).toBeDefined();
    expect((error?.err as { stack?: string }).stack).toContain('ECONNREFUSED');
    // ...but credentials inside a connection string in the message or stack are masked.
    expect(t.rawLogs()).not.toContain('hunter2');
    expect((error?.err as { message?: string }).message).toContain(
      'postgresql://[REDACTED]@db.internal',
    );
  });
});
