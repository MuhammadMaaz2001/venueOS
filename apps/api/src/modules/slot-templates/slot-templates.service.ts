import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateSlotTemplateInput,
  SlotMode,
  SlotTemplateDto,
  SlotTemplateListResponse,
  UpdateSlotTemplateInput,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  DuplicateError,
  FieldValidationError,
  InvalidStateTransitionError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { durationMinutes, resolveSlotTimes } from './slot-times';

interface SlotRow {
  id: string;
  venueId: string;
  name: string;
  mode: SlotMode;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  minHours: number | null;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: SlotRow): SlotTemplateDto {
  return {
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    mode: row.mode,
    startTime: row.startTime,
    endTime: row.endTime,
    daysOfWeek: [...row.daysOfWeek].sort((a, b) => a - b),
    minHours: row.minHours,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SlotTemplatesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  async list(
    venueId: string | undefined,
    includeInactive: boolean,
  ): Promise<SlotTemplateListResponse> {
    const { tenantId } = this.access;
    const venueIds = this.venueScope.filterIds(venueId === undefined ? undefined : [venueId]);
    const rows = await this.tenantDb.tx((tx) =>
      tx.slotTemplate.findMany({
        where: {
          tenantId,
          ...(venueIds === undefined ? {} : { venueId: { in: venueIds } }),
          ...(includeInactive ? {} : { active: true }),
        },
        orderBy: [{ active: 'desc' }, { startTime: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<SlotTemplateDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateSlotTemplateInput): Promise<SlotTemplateDto> {
    const { tenantId } = this.access;
    this.venueScope.assertAccess(input.venueId);
    return this.tenantDb.tx(async (tx) => {
      const venue = await tx.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, active: true, opensAt: true, closesAt: true },
      });
      if (!venue) throw new NotFoundError();
      if (!venue.active) throw new InvalidStateTransitionError('This venue is deactivated.');

      const times = resolveSlotTimes(input, venue);
      await this.assertNameFree(tx, venue.id, input.name);
      const created = await tx.slotTemplate.create({
        data: {
          tenantId,
          venueId: venue.id,
          name: input.name,
          mode: input.mode,
          ...times,
          daysOfWeek: [...input.daysOfWeek].sort((a, b) => a - b),
          minHours: input.mode === 'HOURLY' ? (input.minHours ?? null) : null,
        },
      });
      const dto = toDto(created);
      await this.audit.record(tx, {
        action: 'slot_template.create',
        entityType: 'slot_template',
        entityId: created.id,
        venueId: venue.id,
        after: dto,
      });
      return dto;
    });
  }

  async update(id: string, input: UpdateSlotTemplateInput): Promise<SlotTemplateDto> {
    const { tenantId } = this.access;
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = toDto(current);

      if (current.mode === 'FULL_DAY' && (input.startTime || input.endTime)) {
        throw new FieldValidationError('startTime', 'A full-day slot has no times');
      }
      if (current.mode !== 'HOURLY' && input.minHours != null) {
        throw new FieldValidationError('minHours', 'Only hourly slots have a minimum');
      }

      const venue = await tx.venue.findFirst({
        where: { id: current.venueId, tenantId },
        select: { active: true, opensAt: true, closesAt: true },
      });
      if (!venue) throw new NotFoundError();
      if (input.active === true && !current.active && !venue.active) {
        throw new InvalidStateTransitionError('This venue is deactivated.');
      }

      const minHours = input.minHours === undefined ? current.minHours : input.minHours;
      // Times are only re-validated when the edit names one (an old slot stays editable after the venue's hours changed).
      const timesChanged = input.startTime !== undefined || input.endTime !== undefined;
      const times = timesChanged
        ? resolveSlotTimes(
            {
              mode: current.mode,
              startTime: input.startTime ?? current.startTime,
              endTime: input.endTime ?? current.endTime,
              minHours,
            },
            venue,
          )
        : {};
      if (
        !timesChanged &&
        minHours !== null &&
        durationMinutes(current.startTime, current.endTime) < minHours * 60
      ) {
        throw new FieldValidationError('minHours', 'The minimum is longer than the slot window');
      }
      const name = input.name ?? current.name;
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        await this.assertNameFree(tx, current.venueId, name);
      }

      const changed = await tx.slotTemplate.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          name,
          ...times,
          ...(input.daysOfWeek === undefined
            ? {}
            : { daysOfWeek: [...input.daysOfWeek].sort((a, b) => a - b) }),
          minHours,
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();

      const after = toDto(await this.load(tx, id));
      await this.audit.record(tx, {
        action: 'slot_template.update',
        entityType: 'slot_template',
        entityId: id,
        venueId: current.venueId,
        before,
        after,
      });
      return after;
    });
  }

  /** A slot template of the active tenant inside the caller's venue scope, or 404. */
  private async load(tx: DbTx, id: string): Promise<SlotRow> {
    const row = await tx.slotTemplate.findFirst({ where: { id, tenantId: this.access.tenantId } });
    if (!row) throw new NotFoundError();
    this.venueScope.assertAccess(row.venueId);
    return row;
  }

  /** "Lunch" twice in one venue would be indistinguishable in every picker. */
  private async assertNameFree(tx: DbTx, venueId: string, name: string): Promise<void> {
    const clash = await tx.slotTemplate.findFirst({
      where: {
        tenantId: this.access.tenantId,
        venueId,
        active: true,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (clash) throw new DuplicateError('A slot with this name already exists in this venue.');
  }
}
