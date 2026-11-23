import { Injectable } from '@nestjs/common';
import { JobQueue, enqueueEmail } from '@venueos/db';
import type { DbTx, EnqueuedEmail } from '@venueos/db';
import type { EnqueueEmailInput } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';

/**
 * How modules send email: `emailOutbox.enqueue(tx, { to, template, locale, vars })` inside the SAME
 * `TenantDb.tx` as the business change. It appends the `queued` row to `message_logs` (all customer data
 * stays there, under RLS) and enqueues the `email.send` job with `{ tenantId, messageKey }` only. If the
 * transaction rolls back, neither exists (docs/02-system-design.md; docs/04-security.md section 4).
 *
 * The tenant is the session's tenant (CLS), never a parameter: a module cannot queue mail for another
 * tenant, and Row Level Security would refuse the insert anyway.
 */
@Injectable()
export class EmailOutbox {
  constructor(
    private readonly queue: JobQueue,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  enqueue(tx: DbTx, input: EnqueueEmailInput): Promise<EnqueuedEmail> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('EmailOutbox.enqueue needs a tenant in the request context');
    return enqueueEmail(this.queue, tx, tenantId, input);
  }
}
