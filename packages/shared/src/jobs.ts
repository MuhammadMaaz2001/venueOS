import { z } from 'zod';

// Background jobs (pg-boss), shared by the API (enqueue) and the worker (run).
// docs/02-system-design.md "Background jobs", docs/04-security.md section 4.

export const JOB_NAMES = {
  EMAIL_SEND: 'email.send',
  /** Dead-letter queue of `email.send`: jobs whose retries ran out, or that can never succeed. */
  EMAIL_SEND_DEAD: 'email.send.dead',
  /** Renders one document (quotation, receipt, event sheet) to PDF and stores it in S3. */
  PDF_RENDER: 'pdf.render',
  PDF_RENDER_DEAD: 'pdf.render.dead',
  /** Daily cleanup of expired auth rows (system job, runs through AuthDb). */
  AUTH_PURGE: 'auth.purge',
  AUTH_PURGE_DEAD: 'auth.purge.dead',
  /** Every few minutes: logs an error line for each dead-letter queue that holds jobs. */
  OPS_DEAD_LETTER_CHECK: 'ops.dead-letter-check',
  OPS_DEAD_LETTER_CHECK_DEAD: 'ops.dead-letter-check.dead',
  /** Every 15 minutes: finds open leads whose follow-up time has passed (scanner, ids only). */
  LEADS_FOLLOW_UP: 'leads.follow-up',
  LEADS_FOLLOW_UP_DEAD: 'leads.follow-up.dead',
  /** One per due lead: emails the assignee once per follow-up. */
  LEADS_FOLLOW_UP_NOTIFY: 'leads.follow-up.notify',
  LEADS_FOLLOW_UP_NOTIFY_DEAD: 'leads.follow-up.notify.dead',
  /** Every 5 minutes: finds tentative holds that ended and holds that are about to end (scanner, ids only). */
  HOLDS_EXPIRE: 'holds.expire',
  HOLDS_EXPIRE_DEAD: 'holds.expire.dead',
  /** One per ended hold: sets the booking EXPIRED (the slot is free again) and emails the agent. */
  HOLDS_EXPIRE_RUN: 'holds.expire.run',
  HOLDS_EXPIRE_RUN_DEAD: 'holds.expire.run.dead',
  /** One per hold about to end: emails the agent once. */
  HOLDS_WARN_RUN: 'holds.warn.run',
  HOLDS_WARN_RUN_DEAD: 'holds.warn.run.dead',
  /** Hourly: finds confirmed bookings whose last session is over (scanner, ids only). */
  BOOKINGS_COMPLETE: 'bookings.complete',
  BOOKINGS_COMPLETE_DEAD: 'bookings.complete.dead',
  /** One per such booking: completes it when its balance is paid. */
  BOOKINGS_COMPLETE_RUN: 'bookings.complete.run',
  BOOKINGS_COMPLETE_RUN_DEAD: 'bookings.complete.run.dead',
  /** Hourly: finds payment schedule items due soon that were not reminded yet (scanner, ids only). */
  PAYMENT_DUE: 'reminders.payment-due',
  PAYMENT_DUE_DEAD: 'reminders.payment-due.dead',
  /** One per such item: emails the customer once, unless the item is already paid. */
  PAYMENT_DUE_RUN: 'reminders.payment-due.run',
  PAYMENT_DUE_RUN_DEAD: 'reminders.payment-due.run.dead',
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

/** How long a worker may hold one `pdf.render` job (Chromium start + render + upload) before it is given away. */
export const PDF_RENDER_EXPIRE_SECONDS = 180;

/** How long a worker may hold one `leads.follow-up.notify` job (one query, one email enqueued). */
export const LEADS_FOLLOW_UP_NOTIFY_EXPIRE_SECONDS = 300;

/** How long a worker may hold one system job (`auth.purge`, the dead-letter check). */
export const SYSTEM_JOB_EXPIRE_SECONDS = 900;

/** Where the sealed secret variables live inside `message_logs.template_vars`. */
export const SEALED_VARS_KEY = '__sealed';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be a plain identifier');

/**
 * Payload of `email.send`. Exactly `{ tenantId, messageKey }` and nothing else: `pgboss.job` is not
 * protected by Row Level Security, so nothing customer-related (recipient, template variables, names,
 * amounts) may ever be put into it. All of that lives on the RLS-protected `message_logs` row with
 * this `messageKey` (docs/04-security.md section 4). `.strict()` makes an extra key a validation error.
 */
export const emailSendPayloadSchema = z.object({ tenantId: id, messageKey: id }).strict();
export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

/**
 * Payload of `leads.follow-up.notify`: identifiers only (`pgboss.job` has no RLS). Everything printed in the email is
 * loaded inside the tenant's transaction.
 */
export const leadFollowUpNotifyPayloadSchema = z.object({ tenantId: id, leadId: id }).strict();
export type LeadFollowUpNotifyPayload = z.infer<typeof leadFollowUpNotifyPayloadSchema>;

/** Payload of `holds.expire.run`, `holds.warn.run` and `bookings.complete.run`: identifiers only. */
export const bookingJobPayloadSchema = z.object({ tenantId: id, bookingId: id }).strict();
export type BookingJobPayload = z.infer<typeof bookingJobPayloadSchema>;

/** Payload of `reminders.payment-due.run`: identifiers only. */
export const paymentDueJobPayloadSchema = z.object({ tenantId: id, itemId: id }).strict();
export type PaymentDueJobPayload = z.infer<typeof paymentDueJobPayloadSchema>;

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
    .refine((v) => JSON.stringify(v).length <= 20_000, 'template variables are too large')
    .refine((v) => !(SEALED_VARS_KEY in v), `${SEALED_VARS_KEY} is reserved`),
  /**
   * Variables that are secrets (a verification, reset or invitation link). They are sealed with AES-256-GCM
   * before they are stored and opened by the worker just before rendering; they never appear in plain text in
   * `message_logs` or `pgboss.job` (docs/04-security.md section 6).
   */
  secretVars: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(64),
      z.string().min(1).max(2000),
    )
    .optional(),
  /**
   * Files to attach, as S3 object KEYS (`tenants/{tenantId}/...`): the queued row keeps keys only, the worker downloads the
   * objects when it sends. The tenant prefix is checked when the email is queued and again before the download.
   */
  attachments: z
    .array(
      z.object({
        key: z.string().regex(/^tenants\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._\-/]{1,400}$/),
        filename: z.string().regex(/^[A-Za-z0-9._ -]{1,100}$/),
      }),
    )
    .max(3)
    .optional(),
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
  /** A file to attach could not be read from the store (not there yet, or the store is down). Retried. */
  'ATTACHMENT_UNAVAILABLE',
  /** Anything else. Retried. */
  'UNEXPECTED',
] as const;
export type EmailFailureCode = (typeof EMAIL_FAILURE_CODES)[number];

/** Codes that can never succeed on a retry: the job is dead-lettered at once. */
export const PERMANENT_EMAIL_FAILURE_CODES: readonly EmailFailureCode[] = [
  'INVALID_PAYLOAD',
  'UNKNOWN_TEMPLATE',
];

/**
 * Payload of `pdf.render`: identifiers only (`pgboss.job` has no RLS). The kind says which document, the
 * entity says which row; everything printed on the PDF is loaded inside the tenant's transaction.
 *
 * `kind` is any well-formed name; the worker answers an unregistered one with the permanent code
 * `UNKNOWN_KIND` (so a rolled-back deploy cannot wedge the queue). `PDF_KINDS` lists the kinds that ship.
 */
export const PDF_KINDS = ['sample', 'quotation', 'receipt'] as const;
export const pdfRenderPayloadSchema = z
  .object({ tenantId: id, kind: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), entityId: id })
  .strict();
export type PdfRenderPayload = z.infer<typeof pdfRenderPayloadSchema>;

/**
 * Failure codes of `pdf.render` (job output and logs; never raw browser or S3 text).
 * Retried: RENDER_TIMEOUT, BROWSER_UNAVAILABLE, STORAGE_UNAVAILABLE, UNEXPECTED.
 * Permanent (dead letter at once): INVALID_PAYLOAD, UNKNOWN_KIND, ENTITY_NOT_FOUND, TEMPLATE_ERROR, TOO_LARGE.
 */
export const PDF_FAILURE_CODES = [
  'INVALID_PAYLOAD',
  'UNKNOWN_KIND',
  'ENTITY_NOT_FOUND',
  'TEMPLATE_ERROR',
  'TOO_LARGE',
  'RENDER_TIMEOUT',
  'BROWSER_UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
  'UNEXPECTED',
] as const;
export type PdfFailureCode = (typeof PDF_FAILURE_CODES)[number];

/** Largest PDF a job may store (docs/04 section 6: files up to 10 MB). */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;

/** S3 object key of a generated PDF. A key, never a URL (docs/02, Documents and email). */
export function pdfObjectKey(tenantId: string, kind: string, entityId: string): string {
  return `tenants/${tenantId}/pdf/${kind}/${entityId}.pdf`;
}
