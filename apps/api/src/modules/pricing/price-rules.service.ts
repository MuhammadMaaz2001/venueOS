import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { money, priceRuleShapeIssues } from '@venueos/shared';
import type {
  AdjustmentKind,
  CreatePriceRuleInput,
  PriceRuleDto,
  PriceRuleKind,
  PriceRuleListResponse,
  UpdatePriceRuleInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AppError,
  FieldValidationError,
  ForbiddenError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { clientMoney, storedMoney, tenantCurrency } from '../../common/money/tenant-money';

interface PriceRuleRow {
  id: string;
  name: string;
  kind: PriceRuleKind;
  spaceId: string | null;
  slotId: string | null;
  daysOfWeek: number[];
  startDate: Date | null;
  endDate: Date | null;
  adjustment: AdjustmentKind;
  value: { toFixed(digits: number): string; toString(): string };
  priority: number;
  active: boolean;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

const dateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);
const toDate = (d: string | null | undefined): Date | null =>
  d === null || d === undefined ? null : new Date(`${d}T00:00:00.000Z`);

/** A percentage is shown as written ("20", "-7.5"); money kinds with the currency's decimals. */
function valueText(row: PriceRuleRow, currency: string): string {
  return row.adjustment === 'PERCENT' ? row.value.toString() : storedMoney(row.value, currency);
}

function toDto(row: PriceRuleRow, currency: string, venueId: string | null): PriceRuleDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    spaceId: row.spaceId,
    slotId: row.slotId,
    venueId,
    daysOfWeek: [...row.daysOfWeek].sort((a, b) => a - b),
    startDate: dateOnly(row.startDate),
    endDate: dateOnly(row.endDate),
    adjustment: row.adjustment,
    value: valueText(row, currency),
    priority: row.priority,
    active: row.active,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface Scope {
  spaceId: string | null;
  slotId: string | null;
  venueId: string | null;
}

/**
 * Price rules (docs/05 section 3 step 2). Reads need `pricing.view`, writes `pricing.manage`. A rule is tenant-wide
 * unless it names a space or slot, so only someone with access to all venues may write an unscoped rule; a venue-limited
 * manager may write rules scoped to a space or slot of their own venues.
 */
@Injectable()
export class PriceRulesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async list(
    includeInactive: boolean,
    spaceId: string | undefined,
    slotId: string | undefined,
  ): Promise<PriceRuleListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const rows = await tx.priceRule.findMany({
        where: {
          tenantId,
          ...(includeInactive ? {} : { active: true }),
          ...(spaceId === undefined ? {} : { spaceId }),
          ...(slotId === undefined ? {} : { slotId }),
        },
        orderBy: [{ active: 'desc' }, { priority: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      });
      const venues = await this.venuesOf(tx, rows);
      return {
        data: rows.map((r) => toDto(r, currency, venues.get(r.id) ?? null)),
        nextCursor: null,
      };
    });
  }

  async get(id: string): Promise<PriceRuleDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      const venues = await this.venuesOf(tx, [row]);
      return toDto(row, await tenantCurrency(tx, tenantId), venues.get(row.id) ?? null);
    });
  }

  async create(input: CreatePriceRuleInput): Promise<PriceRuleDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const scope = await this.resolveScope(tx, input.spaceId ?? null, input.slotId ?? null);
      this.assertMayWrite(scope);
      const value = this.checkedValue(input.adjustment, input.value, currency);
      const created = await tx.priceRule.create({
        data: {
          tenantId,
          name: input.name,
          kind: input.kind,
          spaceId: scope.spaceId,
          slotId: scope.slotId,
          daysOfWeek: input.daysOfWeek ?? [],
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
          adjustment: input.adjustment,
          value,
          priority: input.priority,
        },
      });
      const dto = toDto(created, currency, scope.venueId);
      await this.audit.record(tx, {
        action: 'price_rule.create',
        entityType: 'price_rule',
        entityId: created.id,
        ...(scope.venueId === null ? {} : { venueId: scope.venueId }),
        after: dto,
      });
      return dto;
    });
  }

  async update(id: string, input: UpdatePriceRuleInput): Promise<PriceRuleDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const currency = await tenantCurrency(tx, tenantId);
      const current = await this.load(tx, id);
      const currentScope = await this.resolveScope(tx, current.spaceId, current.slotId, true);
      // Someone limited to some venues may not touch a rule of another venue (404) or a workspace-wide one (403).
      this.assertMayWrite(currentScope);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = toDto(current, currency, currentScope.venueId);

      const spaceId = input.spaceId === undefined ? current.spaceId : input.spaceId;
      const slotId = input.slotId === undefined ? current.slotId : input.slotId;
      const scopeChanged = spaceId !== current.spaceId || slotId !== current.slotId;
      const scope = scopeChanged ? await this.resolveScope(tx, spaceId, slotId) : currentScope;
      if (scopeChanged) this.assertMayWrite(scope);

      const merged = {
        kind: input.kind ?? current.kind,
        daysOfWeek: input.daysOfWeek ?? current.daysOfWeek,
        startDate: input.startDate === undefined ? dateOnly(current.startDate) : input.startDate,
        endDate: input.endDate === undefined ? dateOnly(current.endDate) : input.endDate,
        adjustment: input.adjustment ?? current.adjustment,
        value: input.value ?? valueText(current, currency),
      };
      this.assertShape(merged);
      const value = this.checkedValue(merged.adjustment, merged.value, currency);

      const changed = await tx.priceRule.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          name: input.name ?? current.name,
          kind: merged.kind,
          spaceId: scope.spaceId,
          slotId: scope.slotId,
          daysOfWeek: merged.daysOfWeek,
          startDate: toDate(merged.startDate),
          endDate: toDate(merged.endDate),
          adjustment: merged.adjustment,
          value,
          priority: input.priority ?? current.priority,
          active: input.active ?? current.active,
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();
      const after = toDto(await this.load(tx, id), currency, scope.venueId);
      await this.audit.record(tx, {
        action: 'price_rule.update',
        entityType: 'price_rule',
        entityId: id,
        ...(scope.venueId === null ? {} : { venueId: scope.venueId }),
        before,
        after,
      });
      return after;
    });
  }

  private async load(tx: DbTx, id: string): Promise<PriceRuleRow> {
    const row = await tx.priceRule.findFirst({ where: { id, tenantId: this.caller.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }

  /**
   * The space and slot ids come from the client (no composite FK): load them (CLAUDE.md rule 13). Both must exist,
   * be active (unless `existing`: a rule already pointing at a deactivated space stays editable) and share a venue.
   */
  private async resolveScope(
    tx: DbTx,
    spaceId: string | null,
    slotId: string | null,
    existing = false,
  ): Promise<Scope> {
    const tenantId = this.caller.tenantId;
    const space =
      spaceId === null
        ? null
        : await tx.space.findFirst({
            where: { id: spaceId, tenantId },
            select: { venueId: true, active: true },
          });
    if (spaceId !== null && !space) throw new NotFoundError();
    const slot =
      slotId === null
        ? null
        : await tx.slotTemplate.findFirst({
            where: { id: slotId, tenantId },
            select: { venueId: true, active: true },
          });
    if (slotId !== null && !slot) throw new NotFoundError();
    if (space && slot && space.venueId !== slot.venueId) {
      throw new FieldValidationError(
        'slotId',
        'The space and the slot must belong to the same venue',
      );
    }
    if (!existing) {
      if (space && !space.active)
        throw new FieldValidationError('spaceId', 'This space is inactive');
      if (slot && !slot.active) throw new FieldValidationError('slotId', 'This slot is inactive');
    }
    return { spaceId, slotId, venueId: space?.venueId ?? slot?.venueId ?? null };
  }

  /** Venue-limited callers: only rules scoped to a venue they have; anything else is out of reach. */
  private assertMayWrite(scope: Scope): void {
    if (this.venueScope.unrestricted) return;
    if (scope.venueId === null) {
      throw new ForbiddenError(
        'Only staff with access to all venues can change a price rule that applies to every space.',
      );
    }
    this.venueScope.assertAccess(scope.venueId);
  }

  private assertShape(rule: Parameters<typeof priceRuleShapeIssues>[0]): void {
    const issues = priceRuleShapeIssues(rule);
    if (issues.length > 0) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Some fields are invalid.',
        issues.map((i) => ({ path: i.path, code: 'custom', message: i.message })),
      );
    }
  }

  /** The value in its stored form: money kinds with the currency's decimals, a percentage as written. */
  private checkedValue(adjustment: AdjustmentKind, value: string, currency: string): string {
    return adjustment === 'PERCENT'
      ? money(value).toString()
      : clientMoney(value, currency, 'value');
  }

  /** The venue of each rule that names a space or slot (one query each, not one per rule). */
  private async venuesOf(
    tx: DbTx,
    rows: readonly { id: string; spaceId: string | null; slotId: string | null }[],
  ): Promise<Map<string, string>> {
    const tenantId = this.caller.tenantId;
    const spaceIds = [...new Set(rows.flatMap((r) => (r.spaceId === null ? [] : [r.spaceId])))];
    const slotIds = [...new Set(rows.flatMap((r) => (r.slotId === null ? [] : [r.slotId])))];
    const [spaces, slots] = await Promise.all([
      spaceIds.length === 0
        ? []
        : tx.space.findMany({
            where: { tenantId, id: { in: spaceIds } },
            select: { id: true, venueId: true },
          }),
      slotIds.length === 0
        ? []
        : tx.slotTemplate.findMany({
            where: { tenantId, id: { in: slotIds } },
            select: { id: true, venueId: true },
          }),
    ]);
    const bySpace = new Map(spaces.map((s) => [s.id, s.venueId]));
    const bySlot = new Map(slots.map((s) => [s.id, s.venueId]));
    const out = new Map<string, string>();
    for (const r of rows) {
      const venueId =
        (r.spaceId === null ? undefined : bySpace.get(r.spaceId)) ??
        (r.slotId === null ? undefined : bySlot.get(r.slotId));
      if (venueId !== undefined) out.set(r.id, venueId);
    }
    return out;
  }
}
