import { EnvSchema } from './env.schema';
import type { Env } from './env.schema';

/** Thrown when the environment is invalid. `issues` hold variable names and reasons, never values. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validate the environment once, at startup. An empty variable (`SENTRY_DSN=`) counts as unset. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = EnvSchema.safeParse(present);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(environment)';
      const missing = issue.path.length === 1 && !(String(issue.path[0]) in present);
      return `${name}: ${missing ? 'is required' : issue.message}`;
    }),
  );
}
