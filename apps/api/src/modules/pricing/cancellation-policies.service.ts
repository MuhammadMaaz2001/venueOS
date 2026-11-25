import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import { CancellationTierSchema } from '@venueos/shared';
import type {
  CancellationPolicyDto,
  CancellationPolicyListResponse,
  CancellationTier,
  CreateCancellationPolicyInput,
  UpdateCancellationPolicyInput,
} from '@venueos/shared';
import { z } from 'zod';
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

interface PolicyRow {
  id: string;
  name: string;
  tiers: unknown;
  isDefault: boolean;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

const TiersJson = z.array(CancellationTierSchema);

function toDto(row: PolicyRow): CancellationPolicyDto {
  const parsed = TiersJson.safeParse(row.tiers);
  return {
    id: row.id,
    name: row.name,
    tiers: parsed.success ? parsed.data : [],
    isDefault: row.isDefault,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_MESSAGE = 'A cancellation policy with this name already exists.';
const TENANT_WIDE_MESSAGE =
  'Only staff with access to all venues can change cancellation policies.';
const asJson = (tiers: readonly CancellationTier[]): Prisma.InputJsonValue =>
  tiers.map((t) => ({ minDaysBefore: t.minDaysBefore, refundPct: t.refundPct }));

/**
 * Cancellation policies (docs/05 section 6): refund tiers by days before the first session, one default per workspace.
 * Reads `pricing.view`, writes `pricing.manage`. A booking copies the tiers when it is confirmed, so editing a policy
 * never changes an existing booking.
 */
@Injectable()
export class CancellationPoliciesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(includeInactive: boolean): Promise<CancellationPolicyListResponse> {
    const tenantId = this.caller.tenantId;
    const rows = await this.tenantDb.tx((tx) =>
      tx.cancellationPolicy.findMany({
        where: { tenantId, ...(includeInactive ? {} : { active: true }) },
        orderBy: [{ active: 'desc' }, { isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { data: rows.map(toDto), nextCursor: null };
  }

  async get(id: string): Promise<CancellationPolicyDto> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx, id)));
  }

  async create(input: CreateCancellationPolicyInput): Promise<CancellationPolicyDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        await this.assertNameFree(tx, input.name);
        if (input.isDefault) await this.releaseDefault(tx);
        const created = await tx.cancellationPolicy.create({
          data: {
            tenantId,
            name: input.name,
            tiers: asJson(input.tiers),
            isDefault: input.isDefault,
          },
        });
        const dto = toDto(created);
        await this.audit.record(tx, {
          action: 'cancellation_policy.create',
          entityType: 'cancellation_policy',
          entityId: created.id,
          after: dto,
        });
        return dto;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? new DuplicateError(DUPLICATE_MESSAGE) : error;
    }
  }

  async update(id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicyDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertTenantWide(TENANT_WIDE_MESSAGE);
    try {
      return await this.tenantDb.tx(async (tx) => {
        const current = await this.load(tx, id);
        if (current.rev !== input.rev) throw new VersionConflictError();
        const before = toDto(current);

        const active = input.active ?? current.active;
        if (input.isDefault === true && !active) {
          throw new FieldValidationError(
            'isDefault',
            'An inactive cancellation policy cannot be the default',
          );
        }
        const isDefault = active ? (input.isDefault ?? current.isDefault) : false;
        const renaming = input.name !== undefined && input.name !== current.name;
        const reactivating = input.active === true && !current.active;
        if (active && (renaming || reactivating)) {
          await this.assertNameFree(tx, input.name ?? current.name, id);
        }
        if (isDefault && !current.isDefault) await this.releaseDefault(tx, id);

        const changed = await tx.cancellationPolicy.updateMany({
          where: { id, tenantId, rev: input.rev },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.tiers === undefined ? {} : { tiers: asJson(input.tiers) }),
            isDefault,
            active,
          },
        });
        if (changed.count !== 1) throw new VersionConflictError();
        const after = toDto(await this.load(tx, id));
        await this.audit.record(tx, {
          action: 'cancellation_policy.update',
          entityType: 'cancellation_policy',
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

  private async releaseDefault(tx: DbTx, exceptId?: string): Promise<void> {
    const tenantId = this.caller.tenantId;
    const old = await tx.cancellationPolicy.findFirst({
      where: {
        tenantId,
        isDefault: true,
        ...(exceptId === undefined ? {} : { NOT: { id: exceptId } }),
      },
    });
    if (!old) return;
    await tx.cancellationPolicy.updateMany({
      where: { id: old.id, tenantId },
      data: { isDefault: false },
    });
    await this.audit.record(tx, {
      action: 'cancellation_policy.update',
      entityType: 'cancellation_policy',
      entityId: old.id,
      before: toDto(old),
      after: toDto(await this.load(tx, old.id)),
    });
  }

  private async load(tx: DbTx, id: string): Promise<PolicyRow> {
    const row = await tx.cancellationPolicy.findFirst({
      where: { id, tenantId: this.caller.tenantId },
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async assertNameFree(tx: DbTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.cancellationPolicy.findFirst({
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
