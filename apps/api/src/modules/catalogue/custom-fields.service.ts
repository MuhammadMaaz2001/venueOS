import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type {
  CreateCustomFieldDefInput,
  CustomFieldDefDto,
  CustomFieldDefListResponse,
  CustomFieldEntity,
  CustomFieldType,
  UpdateCustomFieldDefInput,
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
import { CATALOGUE_TENANT_WIDE_MESSAGE } from './menu-items.service';

interface CustomFieldRow {
  id: string;
  entity: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  sensitive: boolean;
  sortOrder: number;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: CustomFieldRow): CustomFieldDefDto {
  return {
    id: row.id,
    entity: row.entity as CustomFieldEntity,
    key: row.key,
    label: row.label,
    type: row.type as CustomFieldType,
    options: row.options,
    required: row.required,
    sensitive: row.sensitive,
    sortOrder: row.sortOrder,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE =
  'A field with this name already exists for these records (it may be deactivated: reactivate it instead).';

/**
 * Tenant-defined fields on customers, bookings, sessions and leads (docs/01 module 3). Only the DEFINITIONS live here;
 * the values are stored on those records (customers: module 4). Reads `catalogue.view`, writes `catalogue.manage`.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(
    entity: CustomFieldEntity | undefined,
    includeInactive: boolean,
  ): Promise<CustomFieldDefListResponse> {
    const tenantId = this.caller.tenantId;
    const rows = await this.tenantDb.tx((tx) =>
      tx.customFieldDef.findMany({
        where: {
          tenantId,
          ...(entity === undefined ? {} : { entity }),
          ...(includeInactive ? {} : { active: true }),
        },
        orderBy: [
          { active: 'desc' },
          { entity: 'asc' },
          { sortOrder: 'asc' },
          { label: 'asc' },
          { id: 'asc' },
        ],
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<CustomFieldDefDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateCustomFieldDefInput): Promise<CustomFieldDefDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        // The key is reserved for good (values are stored under it), also when the field is deactivated.
        const clash = await tx.customFieldDef.findFirst({
          where: { tenantId, entity: input.entity, key: input.key },
          select: { id: true },
        });
        if (clash) throw new DuplicateError(DUPLICATE_MESSAGE);
        const created = await tx.customFieldDef.create({
          data: {
            tenantId,
            entity: input.entity,
            key: input.key,
            label: input.label,
            type: input.type,
            options: input.options,
            required: input.required,
            sensitive: input.sensitive,
            sortOrder: input.sortOrder,
          },
        });
        const dto = toDto(created);
        await this.audit.record(tx, {
          action: 'custom_field.create',
          entityType: 'custom_field',
          entityId: created.id,
          after: dto,
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateCustomFieldDefInput): Promise<CustomFieldDefDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(CATALOGUE_TENANT_WIDE_MESSAGE);
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = toDto(current);
      if (input.options !== undefined) {
        if (current.type !== 'select') {
          throw new FieldValidationError('options', 'Only a choice field has choices');
        }
        if (input.options.length === 0) {
          throw new FieldValidationError('options', 'A choice field needs choices');
        }
      }
      const changed = await tx.customFieldDef.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.options === undefined ? {} : { options: input.options }),
          ...(input.required === undefined ? {} : { required: input.required }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();
      const after = toDto(await this.load(tx, id));
      await this.audit.record(tx, {
        action: 'custom_field.update',
        entityType: 'custom_field',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  private async load(tx: DbTx, id: string): Promise<CustomFieldRow> {
    const row = await tx.customFieldDef.findFirst({
      where: { id, tenantId: this.caller.tenantId },
    });
    if (!row) throw new NotFoundError();
    return row;
  }
}
