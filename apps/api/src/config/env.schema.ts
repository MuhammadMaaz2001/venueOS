import { fieldKeyringEnvSchema } from '@venueos/shared';
import { z } from 'zod';

// Messages below never contain the offending value: config errors are printed at boot and may end
// up in shared logs, and these variables carry credentials (docs/04-security.md section 10).

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/\S+$/.test(v), 'must be a postgres:// connection URL');

const origin = z.string().refine((v) => {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}, 'must be a bare origin such as https://app.example.com (no path, no trailing slash)');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // Required now: needed by /health/ready and every tenant module.
  DATABASE_URL: postgresUrl,
  APP_ORIGIN: origin,

  /** Role venueos_auth: used by the AuthModule alone (sessions, credentials, tokens, invitations). */
  AUTH_DATABASE_URL: postgresUrl,
  /**
   * Keyring for AES-256-GCM sealing (docs/04-security.md section 6): secret email variables (verification,
   * reset and invitation links) now, sensitive customer fields later. The worker needs the same keyring.
   */
  FIELD_ENCRYPTION_KEYS: fieldKeyringEnvSchema,

  // Validated when present, required by the modules that use them.
  S3_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  /** Region the bucket lives in (signs download links); the local store accepts any. */
  S3_REGION: z.string().min(1).default('us-east-1'),
  /** Local S3 (SeaweedFS) only, e.g. http://localhost:9100. Unset in staging/production: the real S3 endpoint. */
  S3_ENDPOINT: z
    .string()
    .refine((v) => /^https?:\/\/\S+$/.test(v), 'must be an http(s):// URL')
    .optional(),
  /** The local store needs path-style addressing; leave unset (false) for AWS S3. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  SENTRY_DSN: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Swagger UI is always on outside production; in production only with this flag. */
  SWAGGER_ENABLED: z.stringbool().default(false),
  /**
   * Number of reverse proxies in front of the API (Express `trust proxy` hop count). Must equal the
   * real hop count of the environment, see docs/08-deployment-and-ops.md.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(300),
  THROTTLE_TTL_MS: z.coerce.number().int().min(1).default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function swaggerEnabled(env: Pick<Env, 'NODE_ENV' | 'SWAGGER_ENABLED'>): boolean {
  return env.NODE_ENV !== 'production' || env.SWAGGER_ENABLED;
}
