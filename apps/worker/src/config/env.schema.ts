import { fieldKeyringEnvSchema } from '@venueos/shared';
import { z } from 'zod';

// Messages never contain the offending value: config errors are printed at boot and may end up in
// shared logs, and these variables carry credentials (docs/04-security.md section 10).

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/\S+$/.test(v), 'must be a postgres:// connection URL');

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** Tenant work: job handlers run as venueos_app inside TenantDb transactions. */
    DATABASE_URL: postgresUrl,
    /** The worker's pg-boss connection (role venueos_jobs: read/write on the pgboss schema only). */
    JOBS_DATABASE_URL: postgresUrl,
    /** auth.purge only (role venueos_auth, through AuthDb). No other worker code may use it. */
    AUTH_DATABASE_URL: postgresUrl,

    /**
     * Keyring that opens the secret variables of queued emails (verification, reset and invitation links are
     * sealed by the API, docs/04-security.md section 6). The same keyring as the API's.
     */
    FIELD_ENCRYPTION_KEYS: fieldKeyringEnvSchema,

    EMAIL_PROVIDER: z.enum(['smtp', 'ses']),
    /** Required for `smtp`, e.g. smtp://localhost:1025 (Mailpit). */
    SMTP_URL: z
      .string()
      .refine((v) => /^smtps?:\/\/\S+$/.test(v), 'must be an smtp:// or smtps:// URL')
      .optional(),
    /** Sender address; the tenant name is the display name (docs/02, Documents and email). */
    EMAIL_FROM_ADDRESS: z.email(),
    /** Required for `ses`. Credentials come from the standard AWS provider chain, never from here. */
    AWS_REGION: z.string().min(1).optional(),

    /** Private bucket for generated PDFs (keys `tenants/{tenantId}/...`). */
    S3_BUCKET: z.string().min(1),
    /** Local S3 (SeaweedFS) only (e.g. http://localhost:9100). Unset in staging/production: the real S3 endpoint. */
    S3_ENDPOINT: z
      .string()
      .refine((v) => /^https?:\/\/\S+$/.test(v), 'must be an http(s):// URL')
      .optional(),
    /** The local store needs path-style addressing. Leave unset (false) for AWS S3. */
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Server-side encryption header on uploads. `none` only for the local store (no KMS). */
    S3_SSE: z.enum(['AES256', 'aws:kms', 'none']).default('AES256'),
    /** Region of the bucket; credentials come from the AWS provider chain (task role), never from here. */
    S3_REGION: z.string().min(1).default('us-east-1'),
    SENTRY_DSN: z.string().min(1).optional(),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** How often an idle worker asks the queue for work. */
    JOB_POLLING_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(2),
    /** Jobs of one queue processed at the same time. */
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    /** `false` stops this worker from registering and firing cron schedules (tests, one-off workers). */
    SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** PDFs rendered at the same time (each is a Chromium page). */
    PDF_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
    /** Use this Chromium instead of Playwright's own download (container images). */
    PDF_CHROMIUM_PATH: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'is required when EMAIL_PROVIDER=smtp',
      });
    }
    if (env.EMAIL_PROVIDER === 'ses' && !env.AWS_REGION) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'is required when EMAIL_PROVIDER=ses',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
