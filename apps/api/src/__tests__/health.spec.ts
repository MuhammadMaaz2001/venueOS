import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';

describe('health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 {status: ok}', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is not served under /v1', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(404);
  });

  it('serves the OpenAPI document and Swagger UI', async () => {
    const ui = await request(app.getHttpServer()).get('/docs');
    expect(ui.status).toBe(200);
    const json = await request(app.getHttpServer()).get('/docs-json');
    expect(json.status).toBe(200);
    expect(json.body.paths['/health']).toBeDefined();
  });
});
