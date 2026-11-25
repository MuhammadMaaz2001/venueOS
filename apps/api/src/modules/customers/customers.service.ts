import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import {
  EmailSchema,
  PHONE_FAILURE_MESSAGES,
  normalizePhone,
  phoneSearchDigits,
} from '@venueos/shared';
import type {
  CreateCustomerInput,
  CustomerDetailDto,
  CustomerDto,
  CustomerDuplicateDto,
  CustomerDuplicatesQuery,
  CustomerDuplicatesResponse,
  CustomerLeadDto,
  CustomerListQuery,
  CustomerListResponse,
  LeadStage,
  RevealedValueDto,
  UpdateCustomerInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { CustomFieldValuesService } from '../../common/custom-fields/custom-field-values.service';
import type { FieldDef } from '../../common/custom-fields/custom-field-values.service';
import {
  FieldValidationError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { newId } from '../../common/ids';
import { searchTerm } from '../../common/like';
import { tenantProfile } from '../../common/tenant/tenant-profile';
import type { TenantProfile } from '../../common/tenant/tenant-profile';

type CustomerRow = Prisma.CustomerGetPayload<object>;

/** The cursor is the id of the last row, wrapped so clients treat it as opaque. */
const encodeCursor = (id: string): string => Buffer.from(`u1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('u1:') || decoded.length < 4) {
    throw new FieldValidationError('cursor', 'Invalid cursor');
  }
  return decoded.slice(3);
}

const DUPLICATE_LIMIT = 20;

/** A phone as typed -> E.164 with the workspace country, or a 400 naming the field. */
export function phoneOrThrow(path: string, raw: string, country: string): string {
  const result = normalizePhone(raw, country);
  if (!result.ok) throw new FieldValidationError(path, PHONE_FAILURE_MESSAGES[result.reason]);
  return result.e164;
}

/**
 * Customers (docs/01 module 4, docs/05 section 12, docs/04 section 6). Tenant-wide data: venue scoping applies to the
 * leads shown on the detail page, not to the customer. Phone is not unique; `duplicates` only warns.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly fields: CustomFieldValuesService,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  async list(query: CustomerListQuery): Promise<CustomerListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const defs = await this.defs(tx);
      const where: Prisma.CustomerWhereInput = {
        tenantId,
        ...(query.includeInactive === 'true' ? {} : { active: true }),
      };
      if (query.search !== undefined) {
        const term = searchTerm(query.search);
        const digits = phoneSearchDigits(query.search);
        where.OR = term
          ? [
              { name: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              ...digits.flatMap((d) => [{ phone: { contains: d } }, { altPhone: { contains: d } }]),
            ]
          : [{ id: { in: [] } }]; // nothing but wildcards: nothing matches
      }
      let cursorId: string | undefined;
      if (query.cursor !== undefined) {
        cursorId = decodeCursor(query.cursor);
        const known = await tx.customer.findFirst({
          where: { id: cursorId, tenantId },
          select: { id: true },
        });
        if (!known) throw new FieldValidationError('cursor', 'Invalid cursor');
      }
      const rows = await tx.customer.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((row) => this.toDto(row, defs)),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  async duplicates(query: CustomerDuplicatesQuery): Promise<CustomerDuplicatesResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const phone =
        query.phone === undefined ? undefined : phoneOrThrow('phone', query.phone, profile.country);
      let email: string | undefined;
      if (query.email !== undefined && query.email !== '') {
        const parsed = EmailSchema.safeParse(query.email);
        if (!parsed.success) throw new FieldValidationError('email', 'Enter a valid email address');
        email = parsed.data;
      }
      const data = await this.findDuplicates(tx, tenantId, {
        phone,
        email,
        excludeId: query.excludeId,
      });
      return { data, nextCursor: null };
    });
  }

  async get(id: string): Promise<CustomerDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const defs = await this.defs(tx);
      const row = await this.load(tx, id);
      return this.detail(tx, tenantId, row, defs);
    });
  }

  // ───────────────────────────── writes ─────────────────────────────

  async create(input: CreateCustomerInput): Promise<CustomerDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const row = await this.createInTx(tx, input, profile);
      const defs = await this.defs(tx);
      return this.detail(tx, tenantId, row, defs);
    });
  }

  /** Creates the customer and its audit row inside the caller's transaction (also used for a lead's inline customer). */
  async createInTx(
    tx: DbTx,
    input: CreateCustomerInput,
    profile: TenantProfile,
  ): Promise<CustomerRow> {
    const tenantId = this.caller.tenantId;
    const id = newId();
    const defs = await this.defs(tx);
    const merged = this.fields.merge({
      defs,
      current: {},
      input: input.customFields,
      tenantId,
      recordId: id,
      country: profile.country,
      creating: true,
    });
    const row = await tx.customer.create({
      data: {
        id,
        tenantId,
        name: input.name,
        phone: phoneOrThrow('phone', input.phone, profile.country),
        altPhone: this.optionalPhone('altPhone', input.altPhone, profile.country) ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        preferredLocale: input.preferredLocale ?? null,
        notes: input.notes ?? null,
        customFields: merged.stored as Prisma.InputJsonObject,
      },
    });
    await this.audit.record(tx, {
      action: 'customer.create',
      entityType: 'customer',
      entityId: id,
      after: this.auditView(row),
    });
    return row;
  }

  async update(id: string, input: UpdateCustomerInput): Promise<CustomerDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const profile = await tenantProfile(tx, tenantId);
      const defs = await this.defs(tx);

      const data: Prisma.CustomerUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.phone !== undefined)
        data.phone = phoneOrThrow('phone', input.phone, profile.country);
      if (input.altPhone !== undefined) {
        data.altPhone = this.optionalPhone('altPhone', input.altPhone, profile.country) ?? null;
      }
      if (input.email !== undefined) data.email = input.email;
      if (input.address !== undefined) data.address = input.address;
      if (input.preferredLocale !== undefined) data.preferredLocale = input.preferredLocale;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.active !== undefined) data.active = input.active;
      let sensitiveChanged: string[] = [];
      if (input.customFields !== undefined) {
        const merged = this.fields.merge({
          defs,
          current: current.customFields,
          input: input.customFields,
          tenantId,
          recordId: id,
          country: profile.country,
          creating: false,
        });
        data.customFields = merged.stored as Prisma.InputJsonObject;
        sensitiveChanged = merged.sensitiveChanged;
      }

      const changed = await tx.customer.updateMany({
        where: { id, tenantId, rev: input.rev },
        data,
      });
      if (changed.count !== 1) throw new VersionConflictError();
      const after = await this.load(tx, id);

      const onlyActive = Object.keys(data).length === 1 && input.active !== undefined;
      const action =
        onlyActive && input.active !== current.active
          ? input.active
            ? 'customer.reactivate'
            : 'customer.deactivate'
          : 'customer.update';
      await this.audit.record(tx, {
        action,
        entityType: 'customer',
        entityId: id,
        before: this.auditView(current),
        after: {
          ...this.auditView(after),
          ...(sensitiveChanged.length > 0 ? { sensitiveFieldsChanged: sensitiveChanged } : {}),
        },
      });
      return this.detail(tx, tenantId, after, defs);
    });
  }

  /** The clear value of one sensitive field. The audit row names the field, never its value. */
  async reveal(id: string, fieldKey: string): Promise<RevealedValueDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      const def = await tx.customFieldDef.findFirst({
        where: { tenantId, entity: 'customer', key: fieldKey, sensitive: true },
        select: { id: true },
      });
      if (!def) throw new NotFoundError();
      const value = this.fields.reveal(row.customFields, tenantId, id, fieldKey);
      if (value === null) throw new NotFoundError();
      await this.audit.record(tx, {
        action: 'customer.reveal_sensitive',
        entityType: 'customer',
        entityId: id,
        after: { fieldKey },
      });
      return { key: fieldKey, value };
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Other active customers with this phone (as their phone or alternative phone) or this email. */
  async findDuplicates(
    tx: DbTx,
    tenantId: string,
    match: {
      phone?: string | undefined;
      email?: string | undefined;
      excludeId?: string | undefined;
    },
  ): Promise<CustomerDuplicateDto[]> {
    const or: Prisma.CustomerWhereInput[] = [];
    if (match.phone) or.push({ phone: match.phone }, { altPhone: match.phone });
    if (match.email) or.push({ email: { equals: match.email, mode: 'insensitive' } });
    if (or.length === 0) return [];
    const rows = await tx.customer.findMany({
      where: {
        tenantId,
        active: true,
        ...(match.excludeId === undefined ? {} : { id: { not: match.excludeId } }),
        OR: or,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: DUPLICATE_LIMIT,
      select: { id: true, name: true, phone: true, altPhone: true, email: true },
    });
    return rows.map((r) => {
      const matchedOn: CustomerDuplicateDto['matchedOn'] = [];
      if (match.phone && (r.phone === match.phone || r.altPhone === match.phone)) {
        matchedOn.push('phone');
      }
      if (match.email && r.email?.toLowerCase() === match.email.toLowerCase())
        matchedOn.push('email');
      return { id: r.id, name: r.name, phone: r.phone, email: r.email, matchedOn };
    });
  }

  private optionalPhone(
    path: string,
    raw: string | null | undefined,
    country: string,
  ): string | null | undefined {
    if (raw === undefined || raw === null) return raw;
    return phoneOrThrow(path, raw, country);
  }

  private defs(tx: DbTx): Promise<FieldDef[]> {
    return tx.customFieldDef.findMany({
      where: { tenantId: this.caller.tenantId, entity: 'customer' },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }, { id: 'asc' }],
    });
  }

  private async load(tx: DbTx, id: string): Promise<CustomerRow> {
    const row = await tx.customer.findFirst({ where: { id, tenantId: this.caller.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  private toDto(row: CustomerRow, defs: readonly FieldDef[]): CustomerDto {
    const { values, sensitiveKeys } = this.fields.display(defs, row.customFields);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      altPhone: row.altPhone,
      email: row.email,
      address: row.address,
      preferredLocale: row.preferredLocale,
      notes: row.notes,
      customFields: values,
      sensitiveKeys,
      active: row.active,
      rev: row.rev,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async detail(
    tx: DbTx,
    tenantId: string,
    row: CustomerRow,
    defs: readonly FieldDef[],
  ): Promise<CustomerDetailDto> {
    const [duplicates, leads] = await Promise.all([
      this.findDuplicates(tx, tenantId, {
        phone: row.phone,
        email: row.email ?? undefined,
        excludeId: row.id,
      }),
      this.leadsOf(tx, tenantId, row.id),
    ]);
    return { ...this.toDto(row, defs), leads, duplicates };
  }

  /** The customer's leads in the caller's venues; none without `lead.view`. */
  private async leadsOf(
    tx: DbTx,
    tenantId: string,
    customerId: string,
  ): Promise<CustomerLeadDto[]> {
    if (!this.caller.has('lead.view')) return [];
    const venueIds = this.venueScope.filterIds();
    const rows = await tx.lead.findMany({
      where: { tenantId, customerId, ...(venueIds ? { venueId: { in: venueIds } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: { venue: { select: { name: true } }, eventType: { select: { name: true } } },
    });
    return rows.map((l) => ({
      id: l.id,
      venueId: l.venueId,
      venueName: l.venue.name,
      eventTypeName: l.eventType?.name ?? null,
      stage: l.stage as LeadStage,
      preferredDate: l.preferredDate ? l.preferredDate.toISOString().slice(0, 10) : null,
      nextFollowUpAt: l.nextFollowUpAt ? l.nextFollowUpAt.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  /** The row as an audit entry shows it: sensitive values never appear, not even masked. */
  private auditView(row: CustomerRow): Record<string, unknown> {
    return {
      name: row.name,
      phone: row.phone,
      altPhone: row.altPhone,
      email: row.email,
      address: row.address,
      preferredLocale: row.preferredLocale,
      notes: row.notes,
      active: row.active,
      customFields: this.fields.forAudit(row.customFields),
    };
  }
}
