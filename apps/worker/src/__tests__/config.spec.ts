import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../config/load-env';

const valid = {
  DATABASE_URL: 'postgresql://venueos_app:secret-app@localhost:5432/venueos',
  JOBS_DATABASE_URL: 'postgresql://venueos_jobs:secret-jobs@localhost:5432/venueos',
  AUTH_DATABASE_URL: 'postgresql://venueos_auth:secret-auth@localhost:5432/venueos',
  S3_BUCKET: 'venueos-test',
  FIELD_ENCRYPTION_KEYS:
    '{"active":"k1","keys":{"k1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}',
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://localhost:1025',
  EMAIL_FROM_ADDRESS: 'bookings@venueos.app',
};

describe('worker configuration', () => {
  it('accepts a minimal SMTP setup and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      JOB_POLLING_INTERVAL_SECONDS: 2,
      JOB_CONCURRENCY: 4,
    });
  });

  it('defaults the storage and PDF settings, and parses the booleans', () => {
    expect(loadEnv(valid)).toMatchObject({
      S3_FORCE_PATH_STYLE: false,
      S3_SSE: 'AES256',
      SCHEDULER_ENABLED: true,
      PDF_CONCURRENCY: 2,
      PDF_RENDER_TIMEOUT_MS: 30_000,
    });
    expect(
      loadEnv({
        ...valid,
        S3_ENDPOINT: 'http://localhost:9100',
        S3_FORCE_PATH_STYLE: 'true',
        S3_SSE: 'none',
        SCHEDULER_ENABLED: 'false',
      }),
    ).toMatchObject({ S3_FORCE_PATH_STYLE: true, S3_SSE: 'none', SCHEDULER_ENABLED: false });
    expect(() => loadEnv({ ...valid, S3_ENDPOINT: 'localhost:9100' })).toThrow(/S3_ENDPOINT/);
  });

  it('treats an empty variable as unset', () => {
    expect(loadEnv({ ...valid, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
  });

  it('requires SMTP_URL for smtp and AWS_REGION for ses', () => {
    const noSmtp: Record<string, string> = { ...valid };
    delete noSmtp.SMTP_URL;
    expect(() => loadEnv(noSmtp)).toThrow(/SMTP_URL: is required when EMAIL_PROVIDER=smtp/);
    expect(() => loadEnv({ ...valid, EMAIL_PROVIDER: 'ses' })).toThrow(
      /AWS_REGION: is required when EMAIL_PROVIDER=ses/,
    );
    expect(
      loadEnv({ ...valid, EMAIL_PROVIDER: 'ses', AWS_REGION: 'ap-south-1' }).EMAIL_PROVIDER,
    ).toBe('ses');
  });

  it('requires an explicit provider, both database URLs and a sender address', () => {
    for (const name of [
      'FIELD_ENCRYPTION_KEYS',
      'EMAIL_PROVIDER',
      'DATABASE_URL',
      'JOBS_DATABASE_URL',
      'AUTH_DATABASE_URL',
      'S3_BUCKET',
      'EMAIL_FROM_ADDRESS',
    ]) {
      const copy: Record<string, string> = { ...valid };
      delete copy[name];
      expect(() => loadEnv(copy), name).toThrow(new RegExp(`${name}: is required`));
    }
    expect(() => loadEnv({ ...valid, EMAIL_PROVIDER: 'carrier-pigeon' })).toThrow(ConfigError);
  });

  it('never puts a value (passwords!) into an error message', () => {
    try {
      loadEnv({ ...valid, DATABASE_URL: 'mysql://venueos_app:secret-app@localhost/venueos' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('secret-app');
    }
  });
});
