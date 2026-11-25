import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateTaxRateInput,
  TaxRateDto,
  TaxRateListResponse,
  UpdateTaxRateInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  DuplicateError,
  FieldValidationError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface TaxRateRow {
  id: string;
  name: string;
  ratePct: { toFixed(digits: number): string };
  inclusive: boolean;
  isDefault: boolean;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: TaxRateRow): TaxRateDto {
  return {
    id: row.id,
    name: row.name,
    ratePct: row.ratePct.toFixed(2),
    inclusive: row.inclusive,
    isDefault: row.isDefault,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'A tax rate with this name already exists.';
const TENANT_WIDE_MESSAGE = 'Only staff with access to all venues can change tax rates.';

/**
 * Tax rates (docs/05 section 3 step 6): exclusive or inclusive, one default per workspace. Reads `pricing.view`,
 * writes `pricing.manage`. Quotations copy the rate they use, so an edit never changes an existing booking.
 */
@Injectable()
export class TaxRatesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(includeInactive: boolean): Promise<TaxRateListResponse> {
    const tenantId = this.caller.tenantId;
    const rows = await this.tenantDb.tx((tx) =>
      tx.taxRate.findMany({
        where: { tenantId, ...(includeInactive ? {} : { active: true }) },
        orderBy: [{ active: 'desc' }, { isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<TaxRateDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateTaxRateInput): Promise<TaxRateDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        await this.assertNameFree(tx, input.name);
        if (input.isDefault) await this.releaseDefault(tx);
        const created = await tx.taxRate.create({
          data: {
            tenantId,
            name: input.name,
            ratePct: input.ratePct,
            inclusive: input.inclusive,
            isDefault: input.isDefault,
          },
        });
        const dto = toDto(created);
        await this.audit.record(tx, {
          action: 'tax_rate.create',
          entityType: 'tax_rate',
          entityId: created.id,
          after: dto,
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateTaxRateInput): Promise<TaxRateDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = toDto(current);

        const active = input.active ?? current.active;
        if (input.isDefault === true && !active) {
          throw new FieldValidationError('isDefault', 'An inactive tax rate cannot be the default');
        }
        // Deactivating the default leaves the workspace without one (the database insists a default is active).
        const isDefault = active ? (input.isDefault ?? current.isDefault) : false;
        const renaming = input.name !== undefined && input.name !== current.name;
        const reactivating = input.active === true && !current.active;
        if (active && (renaming || reactivating)) {
          await this.assertNameFree(tx, input.name ?? current.name, id);
        }
        if (isDefault && !current.isDefault) await this.releaseDefault(tx, id);

        const changed = await tx.taxRate.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.ratePct === undefined ? {} : { ratePct: input.ratePct }),
            ...(input.inclusive === undefined ? {} : { inclusive: input.inclusive }),
            isDefault,
            active,
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        const after = toDto(await this.load(tx, id));
        await this.audit.record(tx, {
          action: 'tax_rate.update',
          entityType: 'tax_rate',
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

  /** Take the default flag off the current default (audited as its own change) before another one gets it. */
  private async releaseDefault(tx: DbTx, exceptId?: string): Promise<void> {
    const tenantId = this.caller.tenantId;
    const old = await tx.taxRate.findFirst({
      where: {
        tenantId,
        isDefault: true,
        ...(exceptId === undefined ? {} : { NOT: { id: exceptId } }),
      },
    });
    if (!old) return;
    await tx.taxRate.updateMany({ where: { id: old.id, tenantId }, data: { isDefault: false } });
    await this.audit.record(tx, {
      action: 'tax_rate.update',
      entityType: 'tax_rate',
      entityId: old.id,
      before: toDto(old),
      after: toDto(await this.load(tx, old.id)),
    });
  }

  private async load(tx: DbTx, id: string): Promise<TaxRateRow> {
    const row = await tx.taxRate.findFirst({ where: { id, tenantId: this.caller.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async assertNameFree(tx: DbTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.taxRate.findFirst({
      where: {
        tenantId: this.caller.tenantId,
        active: true,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { NOT: { id: exceptId } }),
      },
      select: { id: true },
    });
    if (clash) throw new DuplicateError(DUPLICATE_MESSAGE);
  }
}
