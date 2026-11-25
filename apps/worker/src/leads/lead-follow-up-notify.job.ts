import { Inject, Injectable } from '@nestjs/common';
import { JobQueue, TenantDb, enqueueEmail } from '@venueos/db';
import {
  JOB_NAMES,
  LEAD_STAGE_LABELS,
  formatInstantForEmail,
  isOpenLeadStage,
  leadFollowUpNotifyPayloadSchema,
} from '@venueos/shared';
import type { LeadFollowUpNotifyPayload, LeadStage } from '@venueos/shared';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { TenantJob } from '../jobs/tenant-job';
import type { JobContext } from '../jobs/tenant-job';
import type { JobOutput } from '../jobs/registered-job';

/** Injection token of the enqueue-side `JobQueue` (role venueos_app) the notify job sends its email with. */
export const LEADS_JOB_QUEUE = Symbol('LEADS_JOB_QUEUE');

const DEFAULT_APP_ORIGIN = 'http://localhost:3000';

/**
 * `leads.follow-up.notify`: emails the assignee that a follow-up is due, ONCE per follow-up (docs/05 section 14).
 *
 * Everything happens in one tenant transaction: the lead is re-read and re-checked (stage, due time, assignee, not yet
 * notified), the "notified for" stamp is set with a conditional UPDATE (so two workers cannot both win), and the email is
 * queued with `enqueueEmail` (message log row + `email.send` job). Either all of it commits or none: a retry after a
 * crash cannot send twice, and cannot lose the mail. The stamp does not change the lead's `rev`.
 */
@Injectable()
export class LeadFollowUpNotifyJob extends TenantJob<LeadFollowUpNotifyPayload> {
  readonly queue = JOB_NAMES.LEADS_FOLLOW_UP_NOTIFY;
  protected readonly payloadSchema = leadFollowUpNotifyPayloadSchema;

  constructor(
    tenantDb: TenantDb,
    @Inject(LEADS_JOB_QUEUE) private readonly jobQueue: JobQueue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {
    super(tenantDb);
  }

  protected handle(ctx: JobContext<LeadFollowUpNotifyPayload>): Promise<JobOutput> {
    const { tenantId, leadId } = ctx.payload;
    return ctx.tx(async (tx): Promise<JobOutput> => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, tenantId },
        include: {
          customer: { select: { name: true } },
          venue: { select: { name: true } },
          eventType: { select: { name: true } },
          assignee: {
            select: { active: true, user: { select: { name: true, email: true } } },
          },
        },
      });
      if (!lead) return { result: 'LEAD_NOT_FOUND' };
      const due = lead.nextFollowUpAt;
      if (!isOpenLeadStage(lead.stage as LeadStage) || !due || !lead.assigneeId) {
        return { result: 'NOT_OPEN' };
      }
      if (due.getTime() > Date.now()) return { result: 'NOT_DUE' };
      if (lead.followUpNotifiedFor?.getTime() === due.getTime()) return { result: 'ALREADY_SENT' };

      // Claim this follow-up. A concurrent worker, or an edit that moved the follow-up, makes the count 0.
      const claimed = await tx.lead.updateMany({
        where: {
          id: leadId,
          tenantId,
          nextFollowUpAt: due,
          OR: [{ followUpNotifiedFor: null }, { followUpNotifiedFor: { not: due } }],
        },
        data: { followUpNotifiedFor: due },
      });
      if (claimed.count !== 1) return { result: 'CHANGED' };

      const email = lead.assignee?.active ? lead.assignee.user.email : null;
      if (!lead.assignee || !email) {
        // Nobody to tell (the assignee left or has no address): the follow-up is marked as handled, not retried forever.
        ctx.log.warn({ leadId }, 'follow-up is due but the assignee cannot be emailed');
        return { result: 'NO_RECIPIENT' };
      }

      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { timezone: true, defaultLocale: true },
      });
      await enqueueEmail(this.jobQueue, tx, tenantId, {
        to: email,
        template: 'lead.follow-up-due',
        locale: tenant?.defaultLocale ?? 'en',
        event: 'lead.follow_up_due',
        entityType: 'lead',
        entityId: lead.id,
        vars: {
          assigneeName: lead.assignee.user.name,
          customerName: lead.customer.name,
          eventType: lead.eventType?.name ?? 'event',
          venueName: lead.venue.name,
          stage: LEAD_STAGE_LABELS[lead.stage as LeadStage],
          followUpAt: formatInstantForEmail(due, tenant?.timezone ?? 'UTC'),
          leadUrl: `${this.config.APP_ORIGIN ?? DEFAULT_APP_ORIGIN}/leads/${lead.id}`,
        },
      });
      return { result: 'SENT' };
    });
  }
}
