import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../config/load-env';
import { swaggerEnabled } from '../config/env.schema';

const valid = {
  DATABASE_URL: 'postgresql://venueos_app:super-secret-pw@localhost:5433/venueos',
  APP_ORIGIN: 'http://localhost:3000',
};

function issuesFor(env: Record<string, string | undefined>): string[] {
  try {
    loadEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe('loadEnv', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: false,
      TRUST_PROXY: 0,
      THROTTLE_LIMIT: 300,
      THROTTLE_TTL_MS: 60_000,
    });
  });

  it('treats an empty variable as unset', () => {
    expect(loadEnv({ ...valid, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
  });

  it('refuses to start when required variables are missing', () => {
    expect(() => loadEnv({})).toThrow(ConfigError);
    const issues = issuesFor({});
    expect(issues).toContain('DATABASE_URL: is required');
    expect(issues).toContain('APP_ORIGIN: is required');
  });

  it('says "invalid", not "required", for a variable that is set but wrong', () => {
    const issues = issuesFor({ ...valid, PORT: 'abc' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^PORT: /);
    expect(issues[0]).not.toContain('is required');
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['APP_ORIGIN', 'http://localhost:3000/'],
    ['APP_ORIGIN', 'localhost:3000'],
    ['DATABASE_URL', 'mysql://u:p@h/db'],
    ['TRUST_PROXY', '-1'],
    ['LOG_LEVEL', 'loud'],
    ['SWAGGER_ENABLED', 'maybe'],
    ['FIELD_ENCRYPTION_KEYS', 'not json'],
    ['FIELD_ENCRYPTION_KEYS', '{"active":"k2","keys":{"k1":"x"}}'],
  ])('rejects invalid %s=%s', (name, value) => {
    const issues = issuesFor({ ...valid, [name]: value });
    expect(issues.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
  });

  it('accepts a well-formed keyring', () => {
    const env = loadEnv({ ...valid, FIELD_ENCRYPTION_KEYS: '{"active":"k1","keys":{"k1":"abc"}}' });
    expect(env.FIELD_ENCRYPTION_KEYS?.active).toBe('k1');
  });

  it('never puts a variable value in the error', () => {
    const issues = issuesFor({
      DATABASE_URL: 'mysql://venueos_app:super-secret-pw@localhost/x',
      APP_ORIGIN: 'http://localhost:3000/with/path',
      FIELD_ENCRYPTION_KEYS: 'super-secret-key-material',
    });
    expect(issues.length).toBeGreaterThan(0);
    const text = issues.join('\n');
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('with/path');
  });
});

describe('swaggerEnabled', () => {
  it('is on outside production and needs the flag in production', () => {
    expect(swaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: false })).toBe(true);
    expect(swaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: false })).toBe(false);
    expect(swaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: true })).toBe(true);
  });
});
