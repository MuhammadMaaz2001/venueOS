import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { LocalRulesSchema } from '@venueos/shared';
import type {
  CreateVenueInput,
  UpdateVenueInput,
  VenueDto,
  VenueListResponse,
} from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { TenantAccess } from '../../common/access/access-context';
import { PlanLimits } from '../../common/access/plan-limits.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  FieldValidationError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  timezone: string | null;
  opensAt: string | null;
  closesAt: string | null;
  localRules: unknown;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

export function venueToDto(row: VenueRow): VenueDto {
  const rules = LocalRulesSchema.safeParse(row.localRules);
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    timezone: row.timezone,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    localRules: rules.success ? rules.data : {},
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** An empty text box means "nothing": stored as null, never as an empty string. */
const blankToNull = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

@Injectable()
export class VenuesService {
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

  async list(includeInactive: boolean): Promise<VenueListResponse> {
    const { tenantId } = this.access;
    const ids = this.venueScope.filterIds();
    const rows = await this.tenantDb.tx((tx) =>
      tx.venue.findMany({
        where: {
          tenantId,
          ...(ids === undefined ? {} : { id: { in: ids } }),
          ...(includeInactive ? {} : { active: true }),
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(venueToDto), nextCursor: null };
  }

  async get(id: string): Promise<VenueDto> {
    this.venueScope.assertAccess(id);
    return venueToDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateVenueInput): Promise<VenueDto> {
    const { tenantId } = this.access;
    // A new venue is outside every limited caller's scope: they could not even open it afterwards.
    if (!this.venueScope.unrestricted) {
      throw new ForbiddenError('Only staff with access to all venues can add a venue.');
    }
    return this.tenantDb.tx(async (tx) => {
      await this.planLimits.assertRoom(tx, tenantId, 'maxVenues');
      const created = await tx.venue.create({
        data: {
          tenantId,
          name: input.name,
          address: blankToNull(input.address) ?? null,
          city: blankToNull(input.city) ?? null,
          timezone: input.timezone ?? null,
          opensAt: input.opensAt ?? null,
          closesAt: input.closesAt ?? null,
          localRules: input.localRules ?? {},
          photoKeys: [],
        },
      });
      const dto = venueToDto(created);
      await this.audit.record(tx, {
        action: 'venue.create',
        entityType: 'venue',
        entityId: created.id,
        after: dto,
      });
      return dto;
    });
  }

  async update(id: string, input: UpdateVenueInput): Promise<VenueDto> {
    const { tenantId } = this.access;
    this.venueScope.assertAccess(id);
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = venueToDto(current);

      // Opening hours are both-or-neither, also against what is stored when the patch names only one.
      const opensAt = input.opensAt === undefined ? current.opensAt : input.opensAt;
      const closesAt = input.closesAt === undefined ? current.closesAt : input.closesAt;
      if ((opensAt === null) !== (closesAt === null)) {
        throw new FieldValidationError('closesAt', 'Set both opening and closing time, or neither');
      }

      if (input.active === true && !current.active) {
        await this.planLimits.assertRoom(tx, tenantId, 'maxVenues');
      }

      const address = blankToNull(input.address);
      const city = blankToNull(input.city);
      const changed = await tx.venue.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(address === undefined ? {} : { address }),
          ...(city === undefined ? {} : { city }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.opensAt === undefined ? {} : { opensAt: input.opensAt }),
          ...(input.closesAt === undefined ? {} : { closesAt: input.closesAt }),
          ...(input.localRules === undefined ? {} : { localRules: input.localRules }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();

      const after = venueToDto(await this.load(tx, id));
      await this.audit.record(tx, {
        action: 'venue.update',
        entityType: 'venue',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  /** A venue of the active tenant, or 404 (another tenant's id answers like a missing one). */
  private async load(tx: DbTx, id: string): Promise<VenueRow> {
    const row = await tx.venue.findFirst({ where: { id, tenantId: this.access.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }
}
