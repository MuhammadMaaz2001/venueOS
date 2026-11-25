import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreatePackageInput,
  PackageDto,
  PackageListResponse,
  UpdatePackageInput,
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
import { clientMoney, storedMoney, tenantCurrency } from '../../common/money/tenant-money';
import { CATALOGUE_TENANT_WIDE_MESSAGE } from './menu-items.service';

const WITH_ITEMS = {
  items: { include: { menuItem: { select: { name: true, category: true, active: true } } } },
} as const;

interface PackageRow {
  id: string;
  name: string;
  perHeadRate: { toFixed(digits: number): string };
  minGuests: number;
  description: string | null;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  items: {
    menuItemId: string;
    quantity: number;
    menuItem: { name: string; category: string | null; active: boolean };
  }[];
}

function toDto(row: PackageRow, currency: string, showPrices: boolean): PackageDto {
  return {
    id: row.id,
    name: row.name,
    perHeadRate: showPrices ? storedMoney(row.perHeadRate, currency) : null,
    minGuests: row.minGuests,
    description: row.description,
    items: row.items
      .map((i) => ({
        menuItemId: i.menuItemId,
        name: i.menuItem.name,
        category: i.menuItem.category,
        quantity: i.quantity,
        menuItemActive: i.menuItem.active,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.menuItemId.localeCompare(b.menuItemId)),
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'A package with this name already exists.';

/** Per-head packages (docs/01 module 3, docs/05 section 3 step 3). Reads `catalogue.view`, writes `catalogue.manage`. */
@Injectable()
export class PackagesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(includeInactive: boolean): Promise<PackageListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const rows = await tx.package.findMany({
        where: { tenantId, ...(includeInactive ? {} : { active: true }) },
        include: WITH_ITEMS,
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return {
        data: rows.map((r) => toDto(r, currency, this.caller.canSeeCataloguePrices)),
        nextCursor: null,
      };
    });
  }

  async get(id: string): Promise<PackageDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) =>
      toDto(
        await this.load(tx, id),
        await tenantCurrency(tx, tenantId),
        this.caller.canSeeCataloguePrices,
      ),
    );
  }

  async create(input: CreatePackageInput): Promise<PackageDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const currency = await tenantCurrency(tx, tenantId);
        const perHeadRate = clientMoney(input.perHeadRate, currency, 'perHeadRate');
        await this.assertNameFree(tx, input.name);
        await this.assertItemsUsable(tx, input.items, new Set());
        const created = await tx.package.create({
          data: {
            tenantId,
            name: input.name,
            perHeadRate,
            minGuests: input.minGuests,
            description: input.description ?? null,
          },
        });
        if (input.items.length > 0) {
          await tx.packageItem.createMany({
            data: input.items.map((i) => ({
              tenantId,
              packageId: created.id,
              menuItemId: i.menuItemId,
              quantity: i.quantity,
            })),
          });
        }
        const dto = toDto(await this.load(tx, created.id), currency, true);
        await this.audit.record(tx, {
          action: 'package.create',
          entityType: 'package',
          entityId: created.id,
          after: dto,
        });
        return toDto(await this.load(tx, created.id), currency, this.caller.canSeeCataloguePrices);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdatePackageInput): Promise<PackageDto> {
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
        const perHeadRate =
          input.perHeadRate === undefined
            ? undefined
            : clientMoney(input.perHeadRate, currency, 'perHeadRate');
        if (input.items !== undefined) {
          await this.assertItemsUsable(
            tx,
            input.items,
            new Set(current.items.map((i) => i.menuItemId)),
          );
        }

        const changed = await tx.package.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            // Always an UPDATE, even when only the dishes change: that is what bumps `rev` (touch_row trigger).
            updatedAt: new Date(),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(perHeadRate === undefined ? {} : { perHeadRate }),
            ...(input.minGuests === undefined ? {} : { minGuests: input.minGuests }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        if (input.items !== undefined) {
          await tx.packageItem.deleteMany({ where: { tenantId, packageId: id } });
          if (input.items.length > 0) {
            await tx.packageItem.createMany({
              data: input.items.map((i) => ({
                tenantId,
                packageId: id,
                menuItemId: i.menuItemId,
                quantity: i.quantity,
              })),
            });
          }
        }
        const reloaded = await this.load(tx, id);
        await this.audit.record(tx, {
          action: 'package.update',
          entityType: 'package',
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

  private async load(tx: DbTx, id: string): Promise<PackageRow> {
    const row = await tx.package.findFirst({
      where: { id, tenantId: this.caller.tenantId },
      include: WITH_ITEMS,
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  /**
   * The menu item ids come from the client and no composite FK ties them to this tenant (CLAUDE.md rule 13): load
   * them. A dish that is not in the package yet must be active; one already in it may stay even if deactivated since.
   */
  private async assertItemsUsable(
    tx: DbTx,
    items: readonly { menuItemId: string }[],
    alreadyInPackage: ReadonlySet<string>,
  ): Promise<void> {
    if (items.length === 0) return;
    const ids = items.map((i) => i.menuItemId);
    const found = await tx.menuItem.findMany({
      where: { tenantId: this.caller.tenantId, id: { in: ids } },
      select: { id: true, active: true },
    });
    if (found.length !== ids.length) throw new NotFoundError();
    if (found.some((m) => !m.active && !alreadyInPackage.has(m.id))) {
      throw new FieldValidationError('items', 'Only active menu items can be added to a package');
    }
  }

  private async assertNameFree(tx: DbTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.package.findFirst({
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
