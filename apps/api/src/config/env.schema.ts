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

// `{"active":"k1","keys":{"k1":"<base64 32-byte key>"}}`. Only the shape is checked here; the key
// material is validated by the encryption service when it exists.
const keyring = z.string().transform((raw, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = z
    .object({ active: z.string().min(1), keys: z.record(z.string(), z.string().min(1)) })
    .refine((k) => k.active in k.keys, 'active must name a key in keys')
    .safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be {"active": "<id>", "keys": {"<id>": "<key>"}}',
    });
    return z.NEVER;
  }
  return result.data;
});

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // Required now: needed by /health/ready and every tenant module.
  DATABASE_URL: postgresUrl,
  APP_ORIGIN: origin,

  // Validated when present, required by the modules that use them (P0-4 auth, field encryption).
  AUTH_DATABASE_URL: postgresUrl.optional(),
  FIELD_ENCRYPTION_KEYS: keyring.optional(),
  S3_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
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
