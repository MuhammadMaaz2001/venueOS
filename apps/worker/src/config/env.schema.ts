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
    /** auth.purge only (P0-6b); validated when present. */
    AUTH_DATABASE_URL: postgresUrl.optional(),

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

    S3_BUCKET: z.string().min(1).optional(),
    SENTRY_DSN: z.string().min(1).optional(),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** How often an idle worker asks the queue for work. */
    JOB_POLLING_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(2),
    /** Jobs of one queue processed at the same time. */
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
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
