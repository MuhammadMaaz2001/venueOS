import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponseSchema } from '@venueos/shared';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';

describe('error format, request id and validation', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('error format (docs/06)', () => {
    it('returns { error: { code, message, requestId } } for a domain error', async () => {
      const res = await t.http().get('/v1/_probe/not-found');
      expect(res.status).toBe(404);
      const body = ErrorResponseSchema.parse(res.body);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBe(res.headers['x-request-id']);
    });

    it('uses the same format for an unknown route', async () => {
      const res = await t.http().get('/v1/does-not-exist');
      expect(res.status).toBe(404);
      expect(ErrorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
    });

    it('uses the same format for malformed JSON', async () => {
      const res = await t
        .http()
        .post('/v1/_probe/echo')
        .set(t.csrfHeaders)
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      expect(res.status).toBe(400);
      expect(ErrorResponseSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
    });

    it('hides internals of an unexpected error and logs them instead', async () => {
      const res = await t.http().get('/v1/_probe/boom').set('X-Request-Id', 'req-boom-0001');
      expect(res.status).toBe(500);
      const body = ErrorResponseSchema.parse(res.body);
      expect(body.error).toMatchObject({ code: 'INTERNAL', requestId: 'req-boom-0001' });
      const text = JSON.stringify(res.body);
      for (const leak of [
        'ECONNREFUSED',
        'hunter2',
        'postgresql',
        'at ',
        'stack',
        'node_modules',
      ]) {
        expect(text).not.toContain(leak);
      }
      const logged = t.logLines().find((line) => line.msg === 'Unhandled exception');
      expect(logged).toMatchObject({ level: 50, requestId: 'req-boom-0001' });
    });

    it('maps the space_occupancies_no_overlap violation to 409 SLOT_TAKEN', async () => {
      const res = await t.http().get('/v1/_probe/slot-taken');
      expect(res.status).toBe(409);
      expect(ErrorResponseSchema.parse(res.body).error.code).toBe('SLOT_TAKEN');
      expect(JSON.stringify(res.body)).not.toContain('space_occupancies');
    });
  });

  describe('request id', () => {
    it('echoes a valid X-Request-Id on success and on errors', async () => {
      const ok = await t.http().get('/health').set('X-Request-Id', 'client-req-12345');
      expect(ok.headers['x-request-id']).toBe('client-req-12345');
      const err = await t
        .http()
        .get('/v1/_probe/not-found')
        .set('X-Request-Id', 'client-req-12345');
      expect(err.headers['x-request-id']).toBe('client-req-12345');
      expect(err.body.error.requestId).toBe('client-req-12345');
    });

    it('generates one when absent', async () => {
      const res = await t.http().get('/health');
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
    });

    it('replaces an unsafe client value instead of echoing it', async () => {
      const res = await t
        .http()
        .get('/v1/_probe/not-found')
        .set('X-Request-Id', 'bad id with spaces!');
      expect(res.headers['x-request-id']).toMatch(/^req_/);
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    });
  });

  describe('validation (Zod pipe)', () => {
    it('accepts a valid body and strips unknown keys', async () => {
      const res = await t
        .http()
        .post('/v1/_probe/echo')
        .set(t.csrfHeaders)
        .send({ name: 'Hall A', guests: 250, tenantId: 'other-tenant', isAdmin: true });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ name: 'Hall A', guests: 250 });
    });

    it('returns 400 VALIDATION_ERROR with field errors and no input values', async () => {
      const res = await t
        .http()
        .post('/v1/_probe/echo')
        .set(t.csrfHeaders)
        .send({ name: '', guests: 'not-a-number-xyz' });
      expect(res.status).toBe(400);
      const body = ErrorResponseSchema.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const paths = (body.error.details as { path: string }[]).map((d) => d.path).sort();
      expect(paths).toEqual(['guests', 'name']);
      expect(JSON.stringify(res.body)).not.toContain('not-a-number-xyz');
    });

    it('rejects out-of-range numbers', async () => {
      const res = await t
        .http()
        .post('/v1/_probe/echo')
        .set(t.csrfHeaders)
        .send({ name: 'x', guests: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
