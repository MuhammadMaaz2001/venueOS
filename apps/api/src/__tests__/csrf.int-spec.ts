import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '@venueos/shared';
import { APP_ORIGIN, createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';

describe('CSRF guard', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('accepts a state-changing request with the header and the allowed Origin', async () => {
    const res = await t.http().post('/v1/_probe/csrf').set(t.csrfHeaders).send({});
    expect(res.status).toBe(201);
  });

  const rejected: [string, Record<string, string>][] = [
    ['no X-Requested-With', { Origin: APP_ORIGIN }],
    ['wrong X-Requested-With', { 'X-Requested-With': 'XMLHttpRequest', Origin: APP_ORIGIN }],
    ['no Origin', { 'X-Requested-With': 'venueos' }],
    ['foreign Origin', { 'X-Requested-With': 'venueos', Origin: 'https://evil.example' }],
    [
      'Origin with a different port',
      { 'X-Requested-With': 'venueos', Origin: 'http://localhost:3001' },
    ],
    ['null Origin', { 'X-Requested-With': 'venueos', Origin: 'null' }],
  ];
  it.each(rejected)('rejects POST with %s', async (_name, headers) => {
    const res = await t.http().post('/v1/_probe/csrf').set(headers).send({});
    expect(res.status).toBe(403);
    const body = ErrorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('CSRF_REJECTED');
    // The response must not say which check failed.
    expect(body.error.message).toBe('The request was rejected for security reasons.');
    expect(body.error.details).toBeUndefined();
  });

  it.each(['patch', 'delete', 'put'] as const)('also checks %s', async (method) => {
    const res = await t.http()[method]('/v1/_probe/csrf').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('does not check safe methods', async () => {
    const res = await t.http().get('/v1/_probe/not-found');
    expect(res.status).toBe(404); // reached the handler, not 403
  });

  it('runs before validation, so a forged request learns nothing about the schema', async () => {
    const res = await t.http().post('/v1/_probe/echo').send({ wrong: true });
    expect(res.status).toBe(403);
  });

  it('does not exempt a request just because it sends a bearer header (no bearer auth exists yet)', async () => {
    const res = await t
      .http()
      .post('/v1/_probe/csrf')
      .set('Authorization', 'Bearer anything')
      .send({});
    expect(res.status).toBe(403);
  });
});
