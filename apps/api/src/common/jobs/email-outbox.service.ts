import { Inject, Injectable } from '@nestjs/common';
import { JobQueue, enqueueEmail } from '@venueos/db';
import type { DbTx, EnqueuedEmail, Sealer } from '@venueos/db';
import type { EnqueueEmailInput } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';

/** Injection token for the Sealer built from FIELD_ENCRYPTION_KEYS (seals secret email variables). */
export const FIELD_SEALER = Symbol('FIELD_SEALER');

/**
 * How modules send email: `emailOutbox.enqueue(tx, { to, template, locale, vars })` inside the SAME
 * `TenantDb.tx` as the business change. It appends the `queued` row to `message_logs` (all customer data
 * stays there, under RLS) and enqueues the `email.send` job with `{ tenantId, messageKey }` only. If the
 * transaction rolls back, neither exists (docs/02-system-design.md; docs/04-security.md section 4).
 *
 * Variables that are secrets (a link carrying a token) go in `secretVars`: they are sealed with AES-256-GCM
 * (AAD = tenant:messageKey) before they are stored and never appear in plain text (docs/04 section 6).
 *
 * The tenant is the session's tenant (CLS), never a parameter: a module cannot queue mail for another
 * tenant, and Row Level Security would refuse the insert anyway. Flows that run BEFORE a session exists
 * (signup, password reset) use `enqueueForTenant`.
 */
@Injectable()
export class EmailOutbox {
  constructor(
    private readonly queue: JobQueue,
    private readonly cls: ClsService<RequestContext>,
    @Inject(FIELD_SEALER) private readonly sealer: Sealer,
  ) {}

  enqueue(tx: DbTx, input: EnqueueEmailInput): Promise<EnqueuedEmail> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('EmailOutbox.enqueue needs a tenant in the request context');
    return enqueueEmail(this.queue, tx, tenantId, input, { sealer: this.sealer });
  }

  /**
   * For flows without a session context (signup, verification, password reset, "account exists"). The
   * tenant owns the `message_logs` row (the log is tenant-scoped) and must come from server-side data (the
   * new tenant, or the user's oldest membership), NEVER from the request. `tx` must run in that tenant's
   * context (`TenantDb.tx({ tenantId })`).
   */
  enqueueForTenant(tx: DbTx, tenantId: string, input: EnqueueEmailInput): Promise<EnqueuedEmail> {
    return enqueueEmail(this.queue, tx, tenantId, input, { sealer: this.sealer });
  }
}
