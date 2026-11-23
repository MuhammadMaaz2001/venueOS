import { z } from 'zod';

// Background jobs (pg-boss), shared by the API (enqueue) and the worker (run).
// docs/02-system-design.md "Background jobs", docs/04-security.md section 4.

export const JOB_NAMES = {
  EMAIL_SEND: 'email.send',
  /** Dead-letter queue of `email.send`: jobs whose retries ran out, or that can never succeed. */
  EMAIL_SEND_DEAD: 'email.send.dead',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Retry policy of every job (docs/02): exponential backoff, at most 5 retries (so 6 attempts), then the
 * dead-letter queue. These values are the queue defaults written by the pg-boss migration AND are sent
 * with every job, so a job never depends on queue configuration alone.
 */
export const JOB_RETRY = {
  retryLimit: 5,
  retryDelaySeconds: 30,
  retryDelayMaxSeconds: 3600,
  retryBackoff: true,
} as const;

/** How long a worker may hold one `email.send` job before pg-boss gives it to another worker. */
export const EMAIL_SEND_EXPIRE_SECONDS = 300;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be a plain identifier');

/**
 * Payload of `email.send`. Exactly `{ tenantId, messageKey }` and nothing else: `pgboss.job` is not
 * protected by Row Level Security, so nothing customer-related (recipient, template variables, names,
 * amounts) may ever be put into it. All of that lives on the RLS-protected `message_logs` row with
 * this `messageKey` (docs/04-security.md section 4). `.strict()` makes an extra key a validation error.
 */
export const emailSendPayloadSchema = z.object({ tenantId: id, messageKey: id }).strict();
export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

/** Values a template can print: strings, numbers, booleans, and nested objects of those. */
export type TemplateVars = { [key: string]: string | number | boolean | TemplateVars };

const templateVarsSchema: z.ZodType<TemplateVars> = z.lazy(() =>
  z.record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(64),
    z.union([z.string().max(2000), z.number().finite(), z.boolean(), templateVarsSchema]),
  ),
);

/**
 * What a module hands to `enqueueEmail`. The tenant is not part of it: it comes from the transaction's
 * session context (CLAUDE.md rule 1).
 */
export const enqueueEmailInputSchema = z.object({
  to: z.email().max(254),
  replyTo: z.email().max(254).optional(),
  /** Template name, e.g. `booking.confirmation`. Must exist in `@venueos/templates`. */
  template: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/)
    .max(100),
  /** BCP 47 language tag; the renderer falls back to `en`. */
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .max(35),
  vars: templateVarsSchema
    .default({})
    .refine((v) => JSON.stringify(v).length <= 20_000, 'template variables are too large'),
  /** Business event the message belongs to (`booking.confirmed`), for the delivery log. */
  event: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: id.optional(),
});
export type EnqueueEmailInput = z.input<typeof enqueueEmailInputSchema>;
export type EnqueueEmailData = z.output<typeof enqueueEmailInputSchema>;

/** `message_logs.status` values written by the email pipeline (the log is an append-only event stream). */
export const MESSAGE_STATUS = {
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  FAILED: 'failed',
} as const;

/**
 * Short, fixed failure codes stored in `message_logs.error` and in the pg-boss job output. Never raw
 * provider or driver text (it can contain addresses and credentials).
 */
export const EMAIL_FAILURE_CODES = [
  /** The job payload or the queued `message_logs` row is not what it must be. Permanent. */
  'INVALID_PAYLOAD',
  /** No template of that name exists. Permanent. */
  'UNKNOWN_TEMPLATE',
  /** The provider could not be reached or throttled us (timeouts, connection errors). Retried. */
  'PROVIDER_UNAVAILABLE',
  /** The provider refused the message. Retried like every non-permanent failure. */
  'PROVIDER_REJECTED',
  /** Anything else. Retried. */
  'UNEXPECTED',
] as const;
export type EmailFailureCode = (typeof EMAIL_FAILURE_CODES)[number];

/** Codes that can never succeed on a retry: the job is dead-lettered at once. */
export const PERMANENT_EMAIL_FAILURE_CODES: readonly EmailFailureCode[] = [
  'INVALID_PAYLOAD',
  'UNKNOWN_TEMPLATE',
];
