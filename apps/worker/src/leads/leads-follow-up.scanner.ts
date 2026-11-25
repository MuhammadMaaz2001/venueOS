import { Injectable } from '@nestjs/common';
import {
  JOB_NAMES,
  LEADS_FOLLOW_UP_NOTIFY_EXPIRE_SECONDS,
  leadFollowUpNotifyPayloadSchema,
} from '@venueos/shared';
import type { LeadFollowUpNotifyPayload } from '@venueos/shared';
import type { ScheduleSpec } from '../jobs/registered-job';
import { PgBossService } from '../queue/pg-boss.service';
import { Scanner } from '../scanners/scanner';
import type { ScanContext, ScanTarget } from '../scanners/scanner';
import { ScannerDb } from '../scanners/scanner-db';

/** The per-lead job: `{ tenantId, leadId }` only (docs/04 section 4). */
export const LEAD_FOLLOW_UP_TARGET: ScanTarget<LeadFollowUpNotifyPayload> = {
  queue: JOB_NAMES.LEADS_FOLLOW_UP_NOTIFY,
  payloadSchema: leadFollowUpNotifyPayloadSchema,
  expireInSeconds: LEADS_FOLLOW_UP_NOTIFY_EXPIRE_SECONDS,
};

/**
 * Open leads that have an assignee, whose follow-up time has passed and that were not yet mailed about THAT follow-up
 * (`follow_up_notified_for` holds the follow-up time the mail was sent for; a new time makes the lead due again). Only
 * `id` and `tenant_id` leave the database. Workspaces that are suspended or cancelled get no mail.
 */
export const DUE_FOLLOW_UPS_SQL = `
  SELECT l.id, l.tenant_id
    FROM leads l
   WHERE l.stage NOT IN ('WON', 'LOST')
     AND l.assignee_id IS NOT NULL
     AND l.next_follow_up_at IS NOT NULL
     AND l.next_follow_up_at <= now()
     AND l.follow_up_notified_for IS DISTINCT FROM l.next_follow_up_at
     AND l.tenant_id IN (SELECT t.id FROM tenants t WHERE t.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE'))`;

/**
 * `leads.follow-up` (docs/05 sections 12 and 14, docs/01 module 5): every 15 minutes, enqueues one
 * `leads.follow-up.notify` per due lead. The singleton key is the lead, so a lead that is still waiting in the queue is
 * not queued twice; the notify job stamps the lead, so a processed one is not found again until its follow-up changes.
 */
@Injectable()
export class LeadsFollowUpScanner extends Scanner {
  readonly queue = JOB_NAMES.LEADS_FOLLOW_UP;
  override readonly schedule: ScheduleSpec = { cron: '*/15 * * * *', tz: 'UTC' };

  constructor(scannerDb: ScannerDb, pgBoss: PgBossService) {
    super(scannerDb, pgBoss);
  }

  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages(DUE_FOLLOW_UPS_SQL)) {
      for (const row of page) {
        if (!row.tenantId) continue;
        await ctx.enqueue(
          LEAD_FOLLOW_UP_TARGET,
          { tenantId: row.tenantId, leadId: row.id },
          `lead-follow-up:${row.id}`,
        );
      }
    }
  }
}
