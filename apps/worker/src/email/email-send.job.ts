import { Inject, Injectable } from '@nestjs/common';
import { SealError, TenantDb, openTemplateVars } from '@venueos/db';
import type { DbTx, Sealer } from '@venueos/db';
import {
  JOB_NAMES,
  MESSAGE_STATUS,
  emailSendPayloadSchema,
  enqueueEmailInputSchema,
  maskEmail,
} from '@venueos/shared';
import type { EmailFailureCode, EmailSendPayload } from '@venueos/shared';
import { PRODUCT_NAME, TemplateError, UnknownTemplateError, renderEmail } from '@venueos/templates';
import type { RenderedEmail } from '@venueos/templates';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { PermanentJobError, RetryableJobError, TenantJob, describeError } from '../jobs/tenant-job';
import type { InvalidPayloadInfo, JobContext } from '../jobs/tenant-job';
import { EMAIL_PROVIDER, EmailProviderError, SEALER, sanitizeDisplayName } from './email-provider';
import type { EmailProvider } from './email-provider';

/** The recipient of a failure row when no queued row could be read. `message_logs.to` is NOT NULL. */
const UNKNOWN_RECIPIENT = 'unknown';

interface QueuedMessage {
  to: string;
  replyTo?: string;
  template: string;
  locale: string;
  vars: Record<string, unknown>;
  event: string | null;
  entityType: string | null;
  entityId: string | null;
}

type Plan =
  | {
      kind: 'invalid';
      message: Pick<QueuedMessage, 'to' | 'event' | 'entityType' | 'entityId'> | null;
    }
  | { kind: 'already-sent' }
  | { kind: 'send'; message: QueuedMessage; tenantName: string };

interface LogFields {
  tenantId: string;
  messageKey: string;
  to: string;
  event: string | null;
  entityType: string | null;
  entityId: string | null;
}

/**
 * `email.send`: delivers one message that the API queued in the same transaction as a business change
 * (docs/02-system-design.md). The payload is `{ tenantId, messageKey }` only; recipient, template, locale
 * and variables are read from the RLS-protected `queued` row of `message_logs`.
 *
 * Three short transactions with the slow part between them:
 *   1. load the queued row, skip when the message was already sent;
 *   2. (no transaction) render the template and call the provider;
 *   3. append the result row (`sent`, or `failed` with a short code).
 *
 * `message_logs` is append-only: one new row per event with the same `message_key`. Delivery is at-least-once:
 * if the process dies after the provider accepted the message and before the `sent` row is written, the retry
 * sends it again. The `sent` check in step 1 prevents every other duplicate.
 */
@Injectable()
export class EmailSendJob extends TenantJob<EmailSendPayload> {
  readonly queue = JOB_NAMES.EMAIL_SEND;
  protected readonly payloadSchema = emailSendPayloadSchema;

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(SEALER) private readonly sealer: Sealer,
  ) {
    super(tenantDb);
  }

  protected async handle(ctx: JobContext<EmailSendPayload>): Promise<void> {
    const { tenantId, messageKey } = ctx.payload;

    // 1. Load.
    const plan = await ctx.tx((tx) => this.plan(tx, ctx));
    if (plan.kind === 'already-sent') {
      ctx.log.info('message was already sent, nothing to do');
      return;
    }
    if (plan.kind === 'invalid') {
      return this.failPermanently(ctx, 'INVALID_PAYLOAD', {
        tenantId,
        messageKey,
        to: plan.message?.to ?? UNKNOWN_RECIPIENT,
        event: plan.message?.event ?? null,
        entityType: plan.message?.entityType ?? null,
        entityId: plan.message?.entityId ?? null,
      });
    }

    const { message, tenantName } = plan;
    const fields: LogFields = {
      tenantId,
      messageKey,
      to: message.to,
      event: message.event,
      entityType: message.entityType,
      entityId: message.entityId,
    };

    // 2. Render and send, with no transaction open.
    let rendered: RenderedEmail;
    try {
      rendered = renderEmail(message.template, message.locale, message.vars);
    } catch (error) {
      if (error instanceof UnknownTemplateError) {
        return this.failPermanently(ctx, 'UNKNOWN_TEMPLATE', fields);
      }
      if (error instanceof TemplateError) {
        // The variables do not fit the template: no retry can change that.
        return this.failPermanently(ctx, 'INVALID_PAYLOAD', fields);
      }
      throw error;
    }

    ctx.log.info(
      {
        recipient: maskEmail(message.to),
        template: message.template,
        locale: rendered.locale,
        provider: this.provider.name,
      },
      'sending email',
    );
    let providerRef: string;
    try {
      ({ providerRef } = await this.provider.send({
        from: {
          // Account mails go out under the product name, not a tenant's (a tenant's name would look like phishing).
          name: rendered.sender === 'product' ? PRODUCT_NAME : sanitizeDisplayName(tenantName),
          address: this.config.EMAIL_FROM_ADDRESS,
        },
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }));
    } catch (error) {
      const code: EmailFailureCode =
        error instanceof EmailProviderError ? error.code : 'UNEXPECTED';
      if (!(error instanceof EmailProviderError))
        ctx.log.error(describeError(error), 'email provider threw');
      await ctx.tx((tx) =>
        this.append(tx, fields, {
          status: MESSAGE_STATUS.FAILED,
          error: code,
          attempt: ctx.attempt,
          isFinal: ctx.isLastAttempt,
        }),
      );
      throw new RetryableJobError(code);
    }

    // 3. Record the result.
    await ctx.tx((tx) =>
      this.append(tx, fields, {
        status: MESSAGE_STATUS.SENT,
        providerRef,
        attempt: ctx.attempt,
      }),
    );
    ctx.log.info({ providerRef }, 'email sent');
  }

  /** The payload did not validate: write the final `failed` row if the tenant is known. */
  protected override async onInvalidPayload(info: InvalidPayloadInfo): Promise<void> {
    if (!info.tenantId) return; // without a tenant there is no RLS scope to write the row in
    const tenantId = info.tenantId;
    await info.tx(async (tx) => {
      const queued = info.messageKey
        ? await tx.messageLog.findFirst({
            where: { messageKey: info.messageKey, status: MESSAGE_STATUS.QUEUED },
            select: { to: true, event: true, entityType: true, entityId: true },
          })
        : null;
      await this.append(
        tx,
        {
          tenantId,
          messageKey: info.messageKey ?? `job:${info.jobId}`,
          to: queued?.to ?? UNKNOWN_RECIPIENT,
          event: queued?.event ?? null,
          entityType: queued?.entityType ?? null,
          entityId: queued?.entityId ?? null,
        },
        {
          status: MESSAGE_STATUS.FAILED,
          error: 'INVALID_PAYLOAD',
          attempt: info.attempt,
          isFinal: true,
        },
      );
    });
  }

  private async plan(tx: DbTx, ctx: JobContext<EmailSendPayload>): Promise<Plan> {
    const rows = await tx.messageLog.findMany({
      where: { messageKey: ctx.payload.messageKey },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (
      rows.some((r) => r.status === MESSAGE_STATUS.SENT || r.status === MESSAGE_STATUS.DELIVERED)
    ) {
      return { kind: 'already-sent' };
    }
    const queued = rows.find((r) => r.status === MESSAGE_STATUS.QUEUED);
    if (!queued) return { kind: 'invalid', message: null };

    const base = {
      to: queued.to,
      event: queued.event,
      entityType: queued.entityType,
      entityId: queued.entityId,
    };
    // Secret variables are sealed for exactly this row (AAD = tenant:messageKey); a blob that was copied from
    // another row, tampered with or sealed with an unknown key does not open: permanent failure.
    let vars: Record<string, unknown>;
    try {
      vars = openTemplateVars(
        this.sealer,
        ctx.tenantId,
        ctx.payload.messageKey,
        queued.templateVars,
      );
    } catch (error) {
      if (error instanceof SealError) return { kind: 'invalid', message: base };
      throw error;
    }
    const parsed = enqueueEmailInputSchema.safeParse({
      to: queued.to,
      replyTo: queued.replyTo ?? undefined,
      template: queued.template,
      locale: queued.locale,
      vars,
    });
    if (!parsed.success) return { kind: 'invalid', message: base };

    const tenant = await tx.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { name: true },
    });
    return {
      kind: 'send',
      tenantName: tenant?.name ?? '',
      message: {
        ...base,
        to: parsed.data.to,
        ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
        template: parsed.data.template,
        locale: parsed.data.locale,
        vars: parsed.data.vars,
      },
    };
  }

  /** Append the final `failed` row, then dead-letter without retries. Always throws. */
  private async failPermanently(
    ctx: JobContext<EmailSendPayload>,
    code: 'INVALID_PAYLOAD' | 'UNKNOWN_TEMPLATE',
    fields: LogFields,
  ): Promise<never> {
    await ctx.tx((tx) =>
      this.append(tx, fields, {
        status: MESSAGE_STATUS.FAILED,
        error: code,
        attempt: ctx.attempt,
        isFinal: true,
      }),
    );
    throw new PermanentJobError(code);
  }

  private append(
    tx: DbTx,
    fields: LogFields,
    event: {
      status: string;
      error?: string;
      providerRef?: string;
      attempt: number;
      isFinal?: boolean;
    },
  ): Promise<unknown> {
    return tx.messageLog.create({
      data: {
        tenantId: fields.tenantId,
        messageKey: fields.messageKey,
        channel: 'email',
        to: fields.to,
        event: fields.event,
        entityType: fields.entityType,
        entityId: fields.entityId,
        status: event.status,
        error: event.error ?? null,
        providerRef: event.providerRef ?? null,
        attempt: event.attempt,
        isFinal: event.isFinal ?? false,
      },
    });
  }
}
