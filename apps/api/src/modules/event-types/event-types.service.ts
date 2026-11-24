import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateEventTypeInput,
  EventTypeDto,
  EventTypeListResponse,
  UpdateEventTypeInput,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface EventTypeRow {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: EventTypeRow): EventTypeDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'An event type with this name already exists.';

@Injectable()
export class EventTypesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get tenantId(): string {
    const id = this.cls.get('access')?.tenantId;
    if (!id) throw new UnauthenticatedError();
    return id;
  }

  async list(includeInactive: boolean): Promise<EventTypeListResponse> {
    const tenantId = this.tenantId;
    const rows = await this.tenantDb.tx((tx) =>
      tx.eventType.findMany({
        where: { tenantId, ...(includeInactive ? {} : { active: true }) },
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<EventTypeDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateEventTypeInput): Promise<EventTypeDto> {
    const tenantId = this.tenantId;
    this.assertTenantWide();
    try {
      return await this.tenantDb.tx(async (tx) => {
        await this.assertNameFree(tx, input.name);
        const created = await tx.eventType.create({
          data: { tenantId, name: input.name, color: input.color ?? null },
        });
        const dto = toDto(created);
        await this.audit.record(tx, {
          action: 'event_type.create',
          entityType: 'event_type',
          entityId: created.id,
          after: dto,
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateEventTypeInput): Promise<EventTypeDto> {
    const tenantId = this.tenantId;
    this.assertTenantWide();
    try {
      return await this.tenantDb.tx(async (tx) => {
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = toDto(current);
        if (input.name !== undefined && input.name !== current.name) {
          await this.assertNameFree(tx, input.name);
        }
        const changed = await tx.eventType.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.color === undefined ? {} : { color: input.color }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        const after = toDto(await this.load(tx, id));
        await this.audit.record(tx, {
          action: 'event_type.update',
          entityType: 'event_type',
          entityId: id,
          before,
          after,
        });
        return after;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  /** Event types belong to the whole workspace: someone limited to some venues may read them, not change them. */
  private assertTenantWide(): void {
    if (!this.venueScope.unrestricted) {
      throw new ForbiddenError('Only staff with access to all venues can change event types.');
    }
  }

  private async load(tx: DbTx, id: string): Promise<EventTypeRow> {
    const row = await tx.eventType.findFirst({ where: { id, tenantId: this.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async assertNameFree(tx: DbTx, name: string): Promise<void> {
    const clash = await tx.eventType.findFirst({
      where: { tenantId: this.tenantId, name },
      select: { id: true },
    });
    if (clash) throw new DuplicateError(DUPLICATE_MESSAGE);
  }
}
