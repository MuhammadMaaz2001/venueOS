import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema, ReadyResponseSchema } from '@venueos/shared';
import { QueueHealthService } from '../health/queue-health.service';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';

describe('health endpoints', () => {
  const apps: TestApp[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((t) => t.app.close()));
  });
  async function start(
    env?: Record<string, string>,
    overrides?: { provide: unknown; useValue: unknown }[],
  ): Promise<TestApp> {
    const t = await createTestApp({ env, overrides });
    apps.push(t);
    return t;
  }

  it('GET /health is liveness: 200 {status: ok}, outside /v1', async () => {
    const t = await start();
    const res = await t.http().get('/health');
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(res.body)).toEqual({ status: 'ok' });
    expect((await t.http().get('/v1/health')).status).toBe(404);
  });

  it('GET /health/ready is 200 when the database answers and the job queue schema is installed', async () => {
    const t = await start();
    const res = await t.http().get('/health/ready');
    expect(res.status).toBe(200);
    expect(ReadyResponseSchema.parse(res.body)).toEqual({
      status: 'ok',
      checks: { database: 'up', queue: 'up' },
    });
    expect((await t.http().get('/v1/health/ready')).status).toBe(404);
  });

  it('GET /health/ready is 503 when the database is unreachable, without leaking details', async () => {
    const t = await start({ DATABASE_URL: 'postgresql://venueos_app:hunter2@127.0.0.1:1/venueos' });
    const res = await t.http().get('/health/ready');
    expect(res.status).toBe(503);
    expect(ReadyResponseSchema.parse(res.body)).toEqual({
      status: 'unavailable',
      checks: { database: 'down', queue: 'down' },
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(t.rawLogs()).not.toContain('hunter2');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('GET /health/ready is 503 with queue down when only the job queue check fails', async () => {
    const t = await start({}, [
      {
        provide: QueueHealthService,
        useValue: { isUp: () => Promise.resolve(false), onModuleDestroy: () => undefined },
      },
    ]);
    const res = await t.http().get('/health/ready');
    expect(res.status).toBe(503);
    expect(ReadyResponseSchema.parse(res.body)).toEqual({
      status: 'unavailable',
      checks: { database: 'up', queue: 'down' },
    });
  });

  it('is not rate limited and does not write access logs (probes call it constantly)', async () => {
    const t = await start({ THROTTLE_LIMIT: '2' });
    for (let i = 0; i < 6; i++) {
      expect((await t.http().get('/health')).status).toBe(200);
    }
    expect(t.logLines().filter((line) => line.req)).toHaveLength(0);
  });
});
