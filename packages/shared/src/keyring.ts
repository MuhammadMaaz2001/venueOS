import { z } from 'zod';

/**
 * `FIELD_ENCRYPTION_KEYS`: `{"active":"k1","keys":{"k1":"<base64 of 32 random bytes>"}}`. Used to seal secrets
 * and sensitive fields with AES-256-GCM (docs/04-security.md section 6). Each ciphertext names the key that
 * made it, so keys can be rotated: add a key, make it `active`, keep the old ones until nothing uses them.
 *
 * This schema checks the SHAPE only (and that ids are plain tokens). The key material is validated by the
 * code that builds the sealer, which refuses to start with a key that is not exactly 32 bytes.
 */
export const FieldKeyringSchema = z
  .object({
    active: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    keys: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string().min(1)),
  })
  .refine((k) => k.active in k.keys, 'active must name a key in keys');
export type FieldKeyring = z.infer<typeof FieldKeyringSchema>;

/** The environment value: a JSON string. Error messages never contain the value (it holds key material). */
export const fieldKeyringEnvSchema = z.string().transform((raw, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = FieldKeyringSchema.safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be {"active": "<id>", "keys": {"<id>": "<base64 key>"}}',
    });
    return z.NEVER;
  }
  return result.data;
});
