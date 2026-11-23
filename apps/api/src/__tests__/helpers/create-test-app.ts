import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Type } from '@nestjs/common';
import { Writable } from 'node:stream';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { LOG_STREAM } from '../../common/logging/logging.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { loadEnv } from '../../config/load-env';
import { configureApp } from '../../configure-app';
import { ProbeController } from './probe.controller';

// vitest does not read .env files. Variables already in the environment win (CI sets them).
for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file missing: fine
  }
}

export const APP_ORIGIN = 'http://localhost:3000';

/** Valid test configuration; `overrides` replace single variables (e.g. THROTTLE_LIMIT). */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    APP_ORIGIN,
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

export interface TestApp {
  app: NestExpressApplication;
  /** Parsed JSON log lines written so far. */
  logLines: () => Record<string, unknown>[];
  /** Raw log output, for "this secret never appears anywhere" assertions. */
  rawLogs: () => string;
  /** Headers every state-changing browser request from the web app carries. */
  csrfHeaders: Record<string, string>;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(
  options: { env?: Record<string, string>; controllers?: Type[] } = {},
): Promise<TestApp> {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [ProbeController],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(options.env))
    .overrideProvider(LOG_STREAM)
    .useValue(stream)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();

  return {
    app,
    rawLogs: () => output,
    logLines: () =>
      output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    csrfHeaders: { 'X-Requested-With': 'venueos', Origin: APP_ORIGIN },
    http: () => request(app.getHttpServer()),
  };
}
