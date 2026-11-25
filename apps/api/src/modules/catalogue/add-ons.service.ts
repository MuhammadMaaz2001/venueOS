import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  AddOnDto,
  AddOnListResponse,
  AddOnPricing,
  CreateAddOnInput,
  UpdateAddOnInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  DuplicateError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { clientMoney, storedMoney, tenantCurrency } from '../../common/money/tenant-money';
import { CATALOGUE_TENANT_WIDE_MESSAGE } from './menu-items.service';

interface AddOnRow {
  id: string;
  name: string;
  pricing: AddOnPricing;
  price: { toFixed(digits: number): string };
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: AddOnRow, currency: string, showPrices: boolean): AddOnDto {
  return {
    id: row.id,
    name: row.name,
    pricing: row.pricing,
    price: showPrices ? storedMoney(row.price, currency) : null,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'An add-on with this name already exists.';

/**
 * Extras sold on top of the rent and package (docs/05 section 3 step 4): FIXED, PER_HEAD, PER_HOUR, PER_UNIT.
 * Reads `catalogue.view`, writes `catalogue.manage`. The vendor link arrives with the vendors module.
 */
@Injectable()
export class AddOnsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(includeInactive: boolean): Promise<AddOnListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const rows = await tx.addOn.findMany({
        where: { tenantId, ...(includeInactive ? {} : { active: true }) },
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return {
        data: rows.map((r) => toDto(r, currency, this.caller.canSeeCataloguePrices)),
        nextCursor: null,
      };
    });
  }

  async get(id: string): Promise<AddOnDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) =>
      toDto(
        await this.load(tx, id),
        await tenantCurrency(tx, tenantId),
        this.caller.canSeeCataloguePrices,
      ),
    );
  }

  async create(input: CreateAddOnInput): Promise<AddOnDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const currency = await tenantCurrency(tx, tenantId);
        const price = clientMoney(input.price, currency, 'price');
        await this.assertNameFree(tx, input.name);
        const created = await tx.addOn.create({
          data: { tenantId, name: input.name, pricing: input.pricing, price },
        });
        await this.audit.record(tx, {
          action: 'add_on.create',
          entityType: 'add_on',
          entityId: created.id,
          after: toDto(created, currency, true),
        });
        return toDto(created, currency, this.caller.canSeeCataloguePrices);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateAddOnInput): Promise<AddOnDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const currency = await tenantCurrency(tx, tenantId);
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = toDto(current, currency, true);
        const becomesActive = input.active ?? current.active;
        const renaming = input.name !== undefined && input.name !== current.name;
        const reactivating = input.active === true && !current.active;
        if (becomesActive && (renaming || reactivating)) {
          await this.assertNameFree(tx, input.name ?? current.name, id);
        }
        const price =
          input.price === undefined ? undefined : clientMoney(input.price, currency, 'price');
        const changed = await tx.addOn.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
            ...(price === undefined ? {} : { price }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        const reloaded = await this.load(tx, id);
        await this.audit.record(tx, {
          action: 'add_on.update',
          entityType: 'add_on',
          entityId: id,
          before,
          after: toDto(reloaded, currency, true),
        });
        return toDto(reloaded, currency, this.caller.canSeeCataloguePrices);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  private async load(tx: DbTx, id: string): Promise<AddOnRow> {
    const row = await tx.addOn.findFirst({ where: { id, tenantId: this.caller.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async assertNameFree(tx: DbTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.addOn.findFirst({
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
