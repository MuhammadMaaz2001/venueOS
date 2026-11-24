import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateSpaceInput,
  SpaceDto,
  SpaceKind,
  SpaceListResponse,
  UpdateSpaceInput,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { PlanLimits } from '../../common/access/plan-limits.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  FieldValidationError,
  InvalidStateTransitionError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { clientMoney, storedMoney, tenantCurrency } from '../../common/money/tenant-money';

interface SpaceRow {
  id: string;
  venueId: string;
  name: string;
  kind: SpaceKind;
  capacitySeated: number | null;
  capacityStanding: number | null;
  minGuests: number | null;
  isCombined: boolean;
  setupBufferMin: number;
  cleanupBufferMin: number;
  baseRent: { toFixed(digits: number): string } | null;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  components: { componentSpaceId: string }[];
}

const WITH_COMPONENTS = { components: { select: { componentSpaceId: true } } } as const;

function toDto(row: SpaceRow, currency: string, showRent: boolean): SpaceDto {
  return {
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    kind: row.kind,
    capacitySeated: row.capacitySeated,
    capacityStanding: row.capacityStanding,
    minGuests: row.minGuests,
    isCombined: row.isCombined,
    componentIds: row.components.map((c) => c.componentSpaceId).sort(),
    setupBufferMin: row.setupBufferMin,
    cleanupBufferMin: row.cleanupBufferMin,
    baseRent: row.baseRent === null || !showRent ? null : storedMoney(row.baseRent, currency),
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SpacesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly planLimits: PlanLimits,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  /**
   * The default rent is pricing information: callers who only read venues (`venue.view`, e.g. Operations) get
   * `null` unless they also manage venues or may see booking prices.
   */
  private get showRent(): boolean {
    const permissions = this.access.permissions;
    return permissions.includes('venue.manage') || permissions.includes('booking.view_prices');
  }

  async list(venueId: string | undefined, includeInactive: boolean): Promise<SpaceListResponse> {
    const { tenantId } = this.access;
    // A venue the caller names only narrows the list; outside their scope it is simply empty.
    const venueIds = this.venueScope.filterIds(venueId === undefined ? undefined : [venueId]);
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const rows = await tx.space.findMany({
        where: {
          tenantId,
          ...(venueIds === undefined ? {} : { venueId: { in: venueIds } }),
          ...(includeInactive ? {} : { active: true }),
        },
        include: WITH_COMPONENTS,
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return { data: rows.map((r) => toDto(r, currency, this.showRent)), nextCursor: null };
    });
  }

  async get(id: string): Promise<SpaceDto> {
    const { tenantId } = this.access;
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      return toDto(row, await tenantCurrency(tx, tenantId), this.showRent);
    });
  }

  async create(input: CreateSpaceInput): Promise<SpaceDto> {
    const { tenantId } = this.access;
    this.venueScope.assertAccess(input.venueId);
    return this.tenantDb.tx(async (tx) => {
      // The venue id comes from the client and is not covered by a composite FK: load it first (rule 13).
      const venue = await tx.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, active: true },
      });
      if (!venue) throw new NotFoundError();
      if (!venue.active) throw new InvalidStateTransitionError('This venue is deactivated.');

      const currency = await tenantCurrency(tx, tenantId);
      const baseRent =
        input.baseRent === undefined || input.baseRent === null
          ? null
          : clientMoney(input.baseRent, currency, 'baseRent');
      if (input.componentIds) await this.assertComponents(tx, venue.id, input.componentIds);

      await this.planLimits.assertRoom(tx, tenantId, 'maxSpaces');
      const created = await tx.space.create({
        data: {
          tenantId,
          venueId: venue.id,
          name: input.name,
          kind: input.kind,
          capacitySeated: input.capacitySeated ?? null,
          capacityStanding: input.capacityStanding ?? null,
          minGuests: input.minGuests ?? null,
          isCombined: input.isCombined,
          setupBufferMin: input.setupBufferMin,
          cleanupBufferMin: input.cleanupBufferMin,
          baseRent,
        },
      });
      if (input.componentIds) {
        await tx.spaceComponent.createMany({
          data: input.componentIds.map((componentSpaceId) => ({
            tenantId,
            combinedSpaceId: created.id,
            componentSpaceId,
          })),
        });
      }
      const dto = toDto(await this.load(tx, created.id), currency, this.showRent);
      await this.audit.record(tx, {
        action: 'space.create',
        entityType: 'space',
        entityId: created.id,
        after: dto,
      });
      return dto;
    });
  }

  async update(id: string, input: UpdateSpaceInput): Promise<SpaceDto> {
    const { tenantId } = this.access;
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const currency = await tenantCurrency(tx, tenantId);
      const before = toDto(current, currency, this.showRent);

      if (input.componentIds !== undefined) {
        if (!current.isCombined) {
          throw new FieldValidationError('componentIds', 'Only a combined space has components');
        }
        await this.assertComponents(tx, current.venueId, input.componentIds, id);
      }

      if (input.active === false && current.active) {
        // A combined space that is still on offer needs its components.
        const partOf = await tx.spaceComponent.findFirst({
          where: { tenantId, componentSpaceId: id, combinedSpace: { active: true } },
          select: { combinedSpaceId: true },
        });
        if (partOf) {
          throw new InvalidStateTransitionError(
            'This space is part of an active combined space. Deactivate or change that one first.',
          );
        }
      }
      if (input.active === true && !current.active) {
        const venue = await tx.venue.findFirst({
          where: { id: current.venueId, tenantId },
          select: { active: true },
        });
        if (!venue?.active) throw new InvalidStateTransitionError('This venue is deactivated.');
        await this.planLimits.assertRoom(tx, tenantId, 'maxSpaces');
      }

      const baseRent =
        input.baseRent === undefined || input.baseRent === null
          ? input.baseRent
          : clientMoney(input.baseRent, currency, 'baseRent');

      const changed = await tx.space.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.capacitySeated === undefined ? {} : { capacitySeated: input.capacitySeated }),
          ...(input.capacityStanding === undefined
            ? {}
            : { capacityStanding: input.capacityStanding }),
          ...(input.minGuests === undefined ? {} : { minGuests: input.minGuests }),
          ...(input.setupBufferMin === undefined ? {} : { setupBufferMin: input.setupBufferMin }),
          ...(input.cleanupBufferMin === undefined
            ? {}
            : { cleanupBufferMin: input.cleanupBufferMin }),
          ...(baseRent === undefined ? {} : { baseRent }),
          ...(input.active === undefined ? {} : { active: input.active }),
          // Components live in another table: a components-only change must still move `rev`.
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();

      if (input.componentIds !== undefined) {
        await tx.spaceComponent.deleteMany({ where: { tenantId, combinedSpaceId: id } });
        await tx.spaceComponent.createMany({
          data: input.componentIds.map((componentSpaceId) => ({
            tenantId,
            combinedSpaceId: id,
            componentSpaceId,
          })),
        });
      }

      const after = toDto(await this.load(tx, id), currency, this.showRent);
      await this.audit.record(tx, {
        action: 'space.update',
        entityType: 'space',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  /** A space of the active tenant inside the caller's venue scope, or 404. */
  private async load(tx: DbTx, id: string): Promise<SpaceRow> {
    const row = await tx.space.findFirst({
      where: { id, tenantId: this.access.tenantId },
      include: WITH_COMPONENTS,
    });
    if (!row) throw new NotFoundError();
    this.venueScope.assertAccess(row.venueId);
    return row;
  }

  /**
   * Components of a combined space: ids from the client are loaded first (unknown or another tenant's: 404),
   * then the rules of docs/05 section 1 are checked so the caller gets a field error; the database triggers
   * stay as the backstop.
   */
  private async assertComponents(
    tx: DbTx,
    venueId: string,
    componentIds: readonly string[],
    selfId?: string,
  ): Promise<void> {
    const { tenantId } = this.access;
    const components = await tx.space.findMany({
      where: { tenantId, id: { in: [...componentIds] } },
      select: { id: true, venueId: true, isCombined: true, active: true },
    });
    if (components.length !== componentIds.length) throw new NotFoundError();
    const fail = (message: string): never => {
      throw new FieldValidationError('componentIds', message);
    };
    for (const component of components) {
      if (component.id === selfId) fail('A space cannot be its own component');
      if (component.venueId !== venueId) fail('All components must belong to the same venue');
      if (component.isCombined) fail('A combined space cannot contain another combined space');
      if (!component.active) fail('A component is deactivated');
    }
  }
}
