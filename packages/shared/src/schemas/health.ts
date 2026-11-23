import { z } from 'zod';

/** GET /health: the process is up. */
export const HealthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** GET /health/ready: dependencies reachable. 200 when `ok`, 503 when `unavailable`. */
export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: z.enum(['up', 'down']),
    /** The pg-boss schema exists at the version this build expects and the queues are there. */
    queue: z.enum(['up', 'down']),
  }),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
