import { Injectable } from '@nestjs/common';
import type { DbTx, Prisma } from '@venueos/db';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import { maskSensitive } from './mask-sensitive';

export interface AuditEntry {
  /** Dotted action name, e.g. `role.update`, `booking.confirm`. */
  action: string;
  entityType: string;
  entityId: string;
  /**
   * The venue the entity belongs to (venue, space, slot template; bookings later). Readers limited to some venues
   * only see rows of their own venues; leave it out for tenant-wide entities (settings, roles, staff).
   */
  venueId?: string;
  /** State before and after the change. Sensitive fields are masked before storing. */
  before?: unknown;
  after?: unknown;
  /**
   * `USER` (default): the acting user and the tenant come from the request context.
   * `SYSTEM`: a job; there is no user, and `tenantId` must be given.
   */
  actor?: 'USER' | 'SYSTEM';
  tenantId?: string;
  /**
   * For a USER entry written outside an authenticated request (signup, accepting an invitation: the actor
   * has no session yet). The id must come from server-side data, never from the request. Without it the
   * user comes from the request context.
   */
  actorUserId?: string;
}

/**
 * Writes an `audit_logs` row (docs/04-security.md section 8) with the CALLER'S transaction, so the
 * audit row and the change commit or roll back together (CLAUDE.md rule 8). Rows are append-only for
 * the app role at the database level. The transaction must already run in the tenant's context
 * (`TenantDb.tx`), otherwise row level security rejects the insert.
 */
@Injectable()
export class AuditService {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  async record(tx: DbTx, entry: AuditEntry): Promise<void> {
    const actorType = entry.actor ?? 'USER';
    const tenantId =
      entry.tenantId ?? (actorType === 'USER' ? this.cls.get('tenantId') : undefined);
    if (!tenantId)
      throw new Error('AuditService.record: no tenant (SYSTEM entries must pass tenantId)');

    let actorUserId: string | null = null;
    if (actorType === 'USER') {
      const userId = entry.actorUserId ?? this.cls.get('userId');
      if (!userId) throw new Error('AuditService.record: USER entry without an authenticated user');
      actorUserId = userId;
    }

    await tx.auditLog.create({
      data: {
        tenantId,
        actorType,
        actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        venueId: entry.venueId ?? null,
        ...(entry.before === undefined
          ? {}
          : { before: maskSensitive(entry.before) as Prisma.InputJsonValue }),
        ...(entry.after === undefined
          ? {}
          : { after: maskSensitive(entry.after) as Prisma.InputJsonValue }),
        ip: this.cls.isActive() ? (this.cls.get('ip') ?? null) : null,
      },
    });
  }
}
