import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import type {
  AuditLogDetailDto,
  AuditLogItemDto,
  AuditLogListQuery,
  AuditLogListResponse,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { VenueScope } from '../../common/access/venue-scope.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  FieldValidationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors';
import { parseDateOnly, startOfLocalDay, startOfNextLocalDay } from '../../common/time/zoned';

const ITEM_SELECT = {
  id: true,
  createdAt: true,
  actorType: true,
  actorUserId: true,
  actorUser: { select: { name: true } },
  action: true,
  entityType: true,
  entityId: true,
  venueId: true,
} satisfies Prisma.AuditLogSelect;

type ItemRow = Prisma.AuditLogGetPayload<{ select: typeof ITEM_SELECT }>;

function toItem(row: ItemRow): AuditLogItemDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorName: row.actorUser?.name ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    venueId: row.venueId,
  };
}

/** The cursor is the id of the last row, wrapped so clients treat it as opaque. */
const encodeCursor = (id: string): string => Buffer.from(`a1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('a1:') || decoded.length < 4) {
    throw new FieldValidationError('cursor', 'Invalid cursor');
  }
  return decoded.slice(3);
}

/**
 * Reads the audit trail (docs/04-security.md section 8). Rows come back exactly as stored: secrets were masked when
 * they were written and nothing here can unmask them. A caller limited to some venues only sees rows of those
 * venues; tenant-wide rows (settings, roles, staff, event types, invitations) need access to all venues.
 */
@Injectable()
export class AuditLogsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly venueScope: VenueScope,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  async list(query: AuditLogListQuery): Promise<AuditLogListResponse> {
    const { tenantId } = this.access;
    return this.tenantDb.tx(async (tx) => {
      const where: Prisma.AuditLogWhereInput = {
        ...this.scopeFilter(),
        ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
        ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
        ...(query.action === undefined ? {} : { action: query.action }),
      };
      const range = await this.dateRange(tx, tenantId, query);
      if (range) where.createdAt = range;

      let cursorId: string | undefined;
      if (query.cursor !== undefined) {
        cursorId = decodeCursor(query.cursor);
        // A cursor must name a row this caller could have been shown: anything else is a bad cursor.
        const known = await tx.auditLog.findFirst({
          where: { id: cursorId, ...this.scopeFilter() },
          select: { id: true },
        });
        if (!known) throw new FieldValidationError('cursor', 'Invalid cursor');
      }

      // Prisma's cursor compares (created_at, id) with the cursor row inside the database, so rows that share a
      // millisecond (timestamptz has microseconds, a JS Date does not) are neither skipped nor repeated.
      const rows = await tx.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
        select: ITEM_SELECT,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toItem),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  async get(id: string): Promise<AuditLogDetailDto> {
    const row = await this.tenantDb.tx((tx) =>
      tx.auditLog.findFirst({
        where: { id, ...this.scopeFilter() },
        select: { ...ITEM_SELECT, before: true, after: true, ip: true },
      }),
    );
    if (!row) throw new NotFoundError();
    return { ...toItem(row), before: row.before ?? null, after: row.after ?? null, ip: row.ip };
  }

  /** Tenant and venue scope of every read: the tenant comes from the session, never from the request. */
  private scopeFilter(): Prisma.AuditLogWhereInput {
    const filter: Prisma.AuditLogWhereInput = { tenantId: this.access.tenantId };
    if (!this.venueScope.unrestricted) {
      filter.venueId = { in: [...(this.venueScope.filterIds() ?? [])] };
    }
    return filter;
  }

  /**
   * `from` / `to`: a date-only value is a whole day of the workspace's time zone (both ends inclusive), an
   * instant is taken as it is.
   */
  private async dateRange(
    tx: DbTx,
    tenantId: string,
    query: Pick<AuditLogListQuery, 'from' | 'to'>,
  ): Promise<Prisma.DateTimeFilter | undefined> {
    const { from, to } = query;
    if (from === undefined && to === undefined) return undefined;

    const needsZone = [from, to].some((v) => v !== undefined && !v.includes('T'));
    let timeZone = 'UTC';
    if (needsZone) {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { timezone: true },
      });
      timeZone = tenant?.timezone ?? 'UTC';
    }

    const range: Prisma.DateTimeFilter = {};
    if (from !== undefined) {
      if (from.includes('T')) range.gte = new Date(from);
      else if (parseDateOnly(from)) range.gte = startOfLocalDay(from, timeZone);
      else throw new FieldValidationError('from', 'Not a real date');
    }
    if (to !== undefined) {
      if (to.includes('T')) range.lte = new Date(to);
      else if (parseDateOnly(to)) range.lt = startOfNextLocalDay(to, timeZone);
      else throw new FieldValidationError('to', 'Not a real date');
    }
    // An end before the start is a mistake of the client, not an empty answer.
    const end = range.lt ?? range.lte;
    if (range.gte instanceof Date && end instanceof Date && range.gte >= end) {
      throw new FieldValidationError('to', 'The end is before the start');
    }
    return range;
  }
}
