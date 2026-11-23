import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Type } from '@nestjs/common';
import { Writable } from 'node:stream';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { AuthContextProvider } from '../../common/access/auth-context.provider';
import { LOG_STREAM } from '../../common/logging/logging.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { loadEnv } from '../../config/load-env';
import { configureApp } from '../../configure-app';
import { AccessProbeController } from './access-probe.controller';
import { ProbeController } from './probe.controller';
import { TestAuthContextProvider } from './test-auth';

// vitest does not read .env files. Variables already in the environment win (CI sets them).
for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file missing: fine
  }
}

export const APP_ORIGIN = 'http://localhost:3000';

/** Test-only keyring (32 bytes of 7), shared with the worker's tests. Never a real key. */
export const TEST_KEYRING = { active: 'k1', keys: { k1: Buffer.alloc(32, 7).toString('base64') } };

/** Valid test configuration; `overrides` replace single variables (e.g. THROTTLE_LIMIT). */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
    FIELD_ENCRYPTION_KEYS: JSON.stringify(TEST_KEYRING),
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
  /** CSRF headers plus the test identity header (`authHeader(userId, tenantId)`). */
  as: (auth: Record<string, string>) => Record<string, string>;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(
  options: {
    env?: Record<string, string>;
    controllers?: Type[];
    /**
     * Keep the application's own AuthContextProvider (which authenticates nobody until P0-4) instead
     * of the test stub. Used to prove that no header can authenticate a real request.
     */
    realAuth?: boolean;
    /** Replace providers (`overrideProvider(token).useValue(value)`), e.g. a failing health check. */
    overrides?: { provide: unknown; useValue: unknown }[];
  } = {},
): Promise<TestApp> {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [ProbeController, AccessProbeController],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(options.env))
    .overrideProvider(LOG_STREAM)
    .useValue(stream);
  if (!options.realAuth) {
    builder = builder.overrideProvider(AuthContextProvider).useClass(TestAuthContextProvider);
  }
  for (const { provide, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();

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
    as: (auth) => ({ 'X-Requested-With': 'venueos', Origin: APP_ORIGIN, ...auth }),
    http: () => request(app.getHttpServer()),
  };
}
