import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateMenuItemInput,
  MenuItemDto,
  MenuItemListResponse,
  UpdateMenuItemInput,
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

interface MenuItemRow {
  id: string;
  name: string;
  category: string | null;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

export function menuItemDto(row: MenuItemRow): MenuItemDto {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'A menu item with this name already exists.';
export const CATALOGUE_TENANT_WIDE_MESSAGE =
  'Only staff with access to all venues can change the catalogue.';

/** Dishes of the workspace (docs/01 module 3). Tenant-wide. Reads `catalogue.view`, writes `catalogue.manage`. */
@Injectable()
export class MenuItemsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(
    includeInactive: boolean,
    category: string | undefined,
  ): Promise<MenuItemListResponse> {
    const tenantId = this.caller.tenantId;
    const rows = await this.tenantDb.tx((tx) =>
      tx.menuItem.findMany({
        where: {
          tenantId,
          ...(includeInactive ? {} : { active: true }),
          ...(category === undefined
            ? {}
            : { category: { equals: category, mode: 'insensitive' } }),
        },
        orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(menuItemDto), nextCursor: null };
  }

  async get(id: string): Promise<MenuItemDto> {
    return menuItemDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateMenuItemInput): Promise<MenuItemDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        await this.assertNameFree(tx, input.name);
        const created = await tx.menuItem.create({
          data: { tenantId, name: input.name, category: input.category ?? null },
        });
        const dto = menuItemDto(created);
        await this.audit.record(tx, {
          action: 'menu_item.create',
          entityType: 'menu_item',
          entityId: created.id,
          after: dto,
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateMenuItemInput): Promise<MenuItemDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = menuItemDto(current);
        const becomesActive = input.active ?? current.active;
        const renaming = input.name !== undefined && input.name !== current.name;
        const reactivating = input.active === true && !current.active;
        if (becomesActive && (renaming || reactivating)) {
          await this.assertNameFree(tx, input.name ?? current.name, id);
        }
        const changed = await tx.menuItem.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        const after = menuItemDto(await this.load(tx, id));
        await this.audit.record(tx, {
          action: 'menu_item.update',
          entityType: 'menu_item',
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

  private async load(tx: DbTx, id: string): Promise<MenuItemRow> {
    const row = await tx.menuItem.findFirst({ where: { id, tenantId: this.caller.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async assertNameFree(tx: DbTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.menuItem.findFirst({
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
