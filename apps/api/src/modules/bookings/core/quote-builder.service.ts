import { Injectable } from '@nestjs/common';
import type { DbTx } from '@venueos/db';
import { LocalRulesSchema } from '@venueos/shared';
import type {
  DiscountInput,
  QuoteWarningDto,
  SessionDto,
  SessionInput,
  TaxRateSnapshotDto,
} from '@venueos/shared';
import { z } from 'zod';
import { Caller } from '../../../common/access/caller.service';
import {
  DiscountLimitError,
  FieldValidationError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../../common/errors/domain-errors';
import { parseDateOnly } from '../../../common/time/zoned';
import { localRuleBreaches, occupancyRange, sessionTimes } from '../../../booking/timing';
import type { LocalRuleBreach, SessionTimes } from '../../../booking/timing';
import {
  DiscountExceedsSubtotalError,
  DiscountLimitExceededError,
  FrozenSessionPricingSchema,
  priceQuote,
} from '../../../pricing';
import type { FrozenSessionPricing, PricingRule, QuoteResult } from '../../../pricing';
import { loadTenantContext } from './support';
import type { TenantContext } from './support';

const dateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

/** A session to price. `reuse` keeps the frozen prices of an existing session where nothing they depend on changed. */
export interface BuildSessionInput extends SessionInput {
  reuse?:
    { frozen: FrozenSessionPricing; spaceId: string; slotId: string; date: string } | undefined;
}

export interface BuildArgs {
  venueId: string;
  sessions: BuildSessionInput[];
  discount: DiscountInput | null | undefined;
  /** The tax rate the booking was quoted with (frozen); `undefined` = the current default rate. */
  taxRate?: TaxRateSnapshotDto | null | undefined;
  /** A booking whose own occupancy is not a conflict (it is being re-quoted). */
  excludeBookingId?: string | undefined;
  /** The cap on the discount: the caller's role limit for a new or changed discount, 100 for one that stays as it was. */
  maxDiscountPct: number;
  /** Whether to look for taken slots (a read-only overlap query per session). */
  warn: boolean;
  /** Who may see which booking number in a SLOT_TAKEN warning (`booking.view`). */
  canSeeBookingNumbers: boolean;
}

type SpaceWithComponents = {
  id: string;
  isCombined: boolean;
  setupBufferMin: number;
  cleanupBufferMin: number;
  components: {
    componentSpace: {
      id: string;
      setupBufferMin: number;
      cleanupBufferMin: number;
      active: boolean;
    };
  }[];
};

/** The load of `tx.space.findMany` that `expandPhysical` needs. */
export const SPACE_WITH_COMPONENTS = {
  components: {
    include: {
      componentSpace: {
        select: { id: true, setupBufferMin: true, cleanupBufferMin: true, active: true },
      },
    },
  },
} as const;

/**
 * The physical spaces a space blocks (docs/05 section 1): itself, or every active component of a combined space. A combined
 * space is cleaned as one, so each component uses the larger of its own buffers and the combined space's.
 */
export function expandPhysical(space: SpaceWithComponents): PhysicalSpace[] {
  if (!space.isCombined) {
    return [
      {
        id: space.id,
        setupBufferMin: space.setupBufferMin,
        cleanupBufferMin: space.cleanupBufferMin,
      },
    ];
  }
  return space.components
    .filter((c) => c.componentSpace.active)
    .map((c) => ({
      id: c.componentSpace.id,
      setupBufferMin: Math.max(space.setupBufferMin, c.componentSpace.setupBufferMin),
      cleanupBufferMin: Math.max(space.cleanupBufferMin, c.componentSpace.cleanupBufferMin),
    }));
}

/** A physical space a session blocks, with the buffers that apply to it. */
export interface PhysicalSpace {
  id: string;
  setupBufferMin: number;
  cleanupBufferMin: number;
}

export interface BuiltSession {
  index: number;
  input: SessionInput;
  /** Every field of the session DTO except `id` and `subtotal`, which depend on the pricing result. */
  dto: Omit<SessionDto, 'id' | 'subtotal' | 'status'>;
  times: SessionTimes;
  frozen: FrozenSessionPricing;
  /** The physical spaces the calendar blocks (the space itself, or the components of a combined space). */
  physical: PhysicalSpace[];
  venueTimezone: string;
}

export interface BuiltQuote {
  tenant: TenantContext;
  venue: {
    id: string;
    name: string;
    timezone: string;
    localRules: z.infer<typeof LocalRulesSchema>;
  };
  sessions: BuiltSession[];
  result: QuoteResult;
  taxRate: TaxRateSnapshotDto | null;
  discount: DiscountInput | null;
  warnings: QuoteWarningDto[];
  /** Local rules a session breaks, per session (also reported as warnings). */
  breaches: { sessionIndex: number; breach: LocalRuleBreach }[];
}

/**
 * Turns the ids and quantities of a quotation into priced lines (docs/05 section 3). The catalogue and rules are loaded in the
 * caller's tenant transaction, so another tenant's space, slot, package or add-on is a 404; the prices come from the
 * database (or from the booking's frozen prices), never from the client. The arithmetic itself is `pricing/quote.ts`.
 */
@Injectable()
export class QuoteBuilder {
  constructor(private readonly caller: Caller) {}

  async build(tx: DbTx, args: BuildArgs): Promise<BuiltQuote> {
    const tenantId = this.caller.tenantId;
    const tenant = await loadTenantContext(tx, tenantId);
    const venueRow = await tx.venue.findFirst({
      where: { id: args.venueId, tenantId, active: true },
      select: { id: true, name: true, timezone: true, localRules: true },
    });
    if (!venueRow) throw new NotFoundError();
    const rules = LocalRulesSchema.safeParse(venueRow.localRules);
    const venue = {
      id: venueRow.id,
      name: venueRow.name,
      timezone: venueRow.timezone ?? tenant.timezone,
      localRules: rules.success ? rules.data : {},
    };

    const unique = <T>(values: (T | null | undefined)[]): T[] => [
      ...new Set(values.filter((v): v is T => v !== null && v !== undefined)),
    ];
    const spaceIds = unique(args.sessions.map((s) => s.spaceId));
    const slotIds = unique(args.sessions.map((s) => s.slotId));
    const eventTypeIds = unique(args.sessions.map((s) => s.eventTypeId));
    const packageIds = unique(args.sessions.map((s) => s.packageId));
    const addOnIds = unique(args.sessions.flatMap((s) => s.addOns.map((a) => a.addOnId)));

    const [spaces, slots, eventTypes, packages, addOns, slotPrices, priceRules, taxRows] =
      await Promise.all([
        tx.space.findMany({
          where: { id: { in: spaceIds }, tenantId, venueId: venue.id, active: true },
          include: SPACE_WITH_COMPONENTS,
        }),
        tx.slotTemplate.findMany({
          where: { id: { in: slotIds }, tenantId, venueId: venue.id, active: true },
        }),
        tx.eventType.findMany({ where: { id: { in: eventTypeIds }, tenantId, active: true } }),
        tx.package.findMany({ where: { id: { in: packageIds }, tenantId, active: true } }),
        tx.addOn.findMany({ where: { id: { in: addOnIds }, tenantId, active: true } }),
        tx.spaceSlotPrice.findMany({
          where: { tenantId, spaceId: { in: spaceIds }, slotId: { in: slotIds } },
        }),
        tx.priceRule.findMany({ where: { tenantId, active: true } }),
        args.taxRate === undefined
          ? tx.taxRate.findFirst({ where: { tenantId, active: true, isDefault: true } })
          : Promise.resolve(null),
      ]);
    const byId = <T extends { id: string }>(rows: T[]): Map<string, T> =>
      new Map(rows.map((r) => [r.id, r]));
    const spaceMap = byId(spaces);
    const slotMap = byId(slots);
    const eventTypeMap = byId(eventTypes);
    const packageMap = byId(packages);
    const addOnMap = byId(addOns);
    // Every id the client sent must exist in this workspace (and venue): else 404, never a silent skip (CLAUDE.md rule 13).
    for (const [ids, map] of [
      [spaceIds, spaceMap],
      [slotIds, slotMap],
      [eventTypeIds, eventTypeMap],
      [packageIds, packageMap],
      [addOnIds, addOnMap],
    ] as const) {
      if (ids.some((id) => !map.has(id))) throw new NotFoundError();
    }

    const taxRate: TaxRateSnapshotDto | null =
      args.taxRate !== undefined
        ? args.taxRate
        : taxRows
          ? {
              id: taxRows.id,
              name: taxRows.name,
              ratePct: taxRows.ratePct.toString(),
              inclusive: taxRows.inclusive,
            }
          : null;

    const built: BuiltSession[] = [];
    const quoteInputs = args.sessions.map((input, index) => {
      const space = spaceMap.get(input.spaceId) as NonNullable<ReturnType<typeof spaceMap.get>>;
      const slot = slotMap.get(input.slotId) as NonNullable<ReturnType<typeof slotMap.get>>;
      const path = `sessions.${index}`;
      if (!parseDateOnly(input.date))
        throw new FieldValidationError(`${path}.date`, 'Enter a real date');
      const weekday = new Date(`${input.date}T00:00:00Z`).getUTCDay();
      if (slot.daysOfWeek.length > 0 && !slot.daysOfWeek.includes(weekday)) {
        throw new FieldValidationError(
          `${path}.date`,
          'This slot is not offered on that day of the week',
        );
      }
      const times = sessionTimes(
        {
          mode: slot.mode,
          startTime: slot.startTime,
          endTime: slot.endTime,
          minHours: slot.minHours,
          defaultMinHours: tenant.settings.minHours,
        },
        input.date,
        venue.timezone,
        { startTime: input.startTime, endTime: input.endTime },
      );

      // The frozen prices of this session: reused where nothing they depend on changed, else read from the catalogue.
      const reuse = input.reuse;
      const sameRent =
        reuse !== undefined &&
        reuse.spaceId === space.id &&
        reuse.slotId === slot.id &&
        reuse.date === input.date;
      let unitRent: string;
      let ruleSet: PricingRule[];
      if (sameRent && reuse) {
        unitRent = reuse.frozen.unitRent;
        ruleSet = reuse.frozen.rules;
      } else {
        const slotPrice = slotPrices.find((p) => p.spaceId === space.id && p.slotId === slot.id);
        const unit = slotPrice?.rent ?? space.baseRent;
        if (unit === null || unit === undefined) {
          throw new InvalidStateTransitionError(
            `No rent is set for ${space.name} and ${slot.name} yet.`,
            { sessionIndex: index },
          );
        }
        unitRent = unit.toString();
        ruleSet = priceRules
          .filter(
            (r) =>
              (r.spaceId === null || r.spaceId === space.id) &&
              (r.slotId === null || r.slotId === slot.id),
          )
          .map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            spaceId: r.spaceId,
            slotId: r.slotId,
            daysOfWeek: r.daysOfWeek,
            startDate: dateOnly(r.startDate),
            endDate: dateOnly(r.endDate),
            adjustment: r.adjustment,
            value: r.value.toString(),
            priority: r.priority,
          }));
      }

      const pkgRow = input.packageId ? packageMap.get(input.packageId) : undefined;
      const frozenPackage: FrozenSessionPricing['package'] = !pkgRow
        ? null
        : reuse?.frozen.package?.id === pkgRow.id
          ? reuse.frozen.package
          : {
              id: pkgRow.id,
              name: pkgRow.name,
              perHeadRate: pkgRow.perHeadRate.toString(),
              minGuests: pkgRow.minGuests,
            };
      const frozenAddOns: FrozenSessionPricing['addOns'] = input.addOns.map((sel) => {
        const kept = reuse?.frozen.addOns.find((a) => a.id === sel.addOnId);
        if (kept) return kept;
        const row = addOnMap.get(sel.addOnId) as NonNullable<ReturnType<typeof addOnMap.get>>;
        return { id: row.id, name: row.name, pricing: row.pricing, price: row.price.toString() };
      });
      const frozen: FrozenSessionPricing = FrozenSessionPricingSchema.parse({
        unitRent,
        rentHours: slot.mode === 'HOURLY' ? times.hours : null,
        rules: ruleSet,
        package: frozenPackage,
        addOns: frozenAddOns,
      });

      const eventType = input.eventTypeId ? eventTypeMap.get(input.eventTypeId) : undefined;
      const physical = expandPhysical(space);
      if (physical.length === 0) {
        throw new FieldValidationError(
          `${path}.spaceId`,
          'This combined space has no active components',
        );
      }

      const billed = Math.max(
        input.guests,
        frozen.package?.minGuests ?? 0,
        input.guaranteedGuests ?? 0,
      );
      const label = `${eventType?.name ?? 'Event'}, ${space.name}, ${slot.name}, ${input.date}`;
      built.push({
        index,
        input,
        times,
        frozen,
        physical,
        venueTimezone: venue.timezone,
        dto: {
          index,
          spaceId: space.id,
          spaceName: space.name,
          date: input.date,
          slotId: slot.id,
          slotName: slot.name,
          startsAt: times.startsAt.toISOString(),
          endsAt: times.endsAt.toISOString(),
          hours: times.hours,
          eventTypeId: eventType?.id ?? null,
          eventTypeName: eventType?.name ?? null,
          packageId: frozen.package?.id ?? null,
          packageName: frozen.package?.name ?? null,
          guests: input.guests,
          guaranteedGuests: input.guaranteedGuests ?? null,
          billedGuests: billed,
          addOns: input.addOns.map((sel) => ({
            addOnId: sel.addOnId,
            name: frozenAddOns.find((a) => a.id === sel.addOnId)?.name ?? '',
            quantity: sel.quantity,
          })),
          setupNotes: input.setupNotes ?? null,
          kitchenNotes: input.kitchenNotes ?? null,
        },
      });
      return {
        index,
        label,
        date: input.date,
        spaceId: space.id,
        slotId: slot.id,
        hours: times.hours,
        guests: input.guests,
        guaranteedGuests: input.guaranteedGuests ?? null,
        addOnQuantities: Object.fromEntries(input.addOns.map((a) => [a.addOnId, a.quantity])),
        frozen,
      };
    });

    this.assertNoSelfOverlap(built);

    let result: QuoteResult;
    try {
      result = priceQuote({
        currency: tenant.currency,
        sessions: quoteInputs,
        taxRate,
        discount: args.discount ?? null,
        maxDiscountPct: args.maxDiscountPct,
      });
    } catch (error) {
      if (error instanceof DiscountLimitExceededError) {
        throw new DiscountLimitError(`Your role may give a discount of up to ${error.limitPct}%.`, {
          limitPct: error.limitPct,
          requestedPct: error.requestedPct,
        });
      }
      if (error instanceof DiscountExceedsSubtotalError) {
        throw new FieldValidationError('discount', 'The discount is more than the total');
      }
      throw error;
    }

    const breaches: BuiltQuote['breaches'] = [];
    for (const s of built) {
      for (const breach of localRuleBreaches(
        venue.localRules,
        { startsAt: s.times.startsAt, endsAt: s.times.endsAt, guests: s.input.guests },
        venue.timezone,
      )) {
        breaches.push({ sessionIndex: s.index, breach });
      }
    }
    const warnings: QuoteWarningDto[] = breaches.map((b) => ({
      code: 'LOCAL_RULE',
      sessionIndex: b.sessionIndex,
      detail: b.breach,
    }));
    if (args.warn) warnings.push(...(await this.takenWarnings(tx, built, args)));

    return {
      tenant,
      venue,
      sessions: built,
      result,
      taxRate,
      discount: args.discount ?? null,
      warnings,
      breaches,
    };
  }

  /** The physical spaces (and buffers) each of the given spaces blocks; an unknown or foreign id is a 404. */
  async physicalSpaces(tx: DbTx, spaceIds: string[]): Promise<Map<string, PhysicalSpace[]>> {
    const spaces = await tx.space.findMany({
      where: { id: { in: spaceIds }, tenantId: this.caller.tenantId },
      include: SPACE_WITH_COMPONENTS,
    });
    if (spaces.length !== new Set(spaceIds).size) throw new NotFoundError();
    return new Map(spaces.map((sp) => [sp.id, expandPhysical(sp)]));
  }

  /** Two sessions of one booking may not block the same physical space at once (the constraint would refuse the hold). */
  private assertNoSelfOverlap(sessions: BuiltSession[]): void {
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const a = sessions[i] as BuiltSession;
        const b = sessions[j] as BuiltSession;
        for (const pa of a.physical) {
          const pb = b.physical.find((p) => p.id === pa.id);
          if (!pb) continue;
          const ra = occupancyRange(
            a.times.startsAt,
            a.times.endsAt,
            pa.setupBufferMin,
            pa.cleanupBufferMin,
          );
          const rb = occupancyRange(
            b.times.startsAt,
            b.times.endsAt,
            pb.setupBufferMin,
            pb.cleanupBufferMin,
          );
          if (ra.startsAt < rb.endsAt && rb.startsAt < ra.endsAt) {
            throw new FieldValidationError(
              `sessions.${j}.date`,
              'Two sessions of this booking use the same space at the same time',
            );
          }
        }
      }
    }
  }

  /** A read-only look at the calendar: which sessions land on a slot somebody already holds (a warning, never an error). */
  private async takenWarnings(
    tx: DbTx,
    sessions: BuiltSession[],
    args: Pick<BuildArgs, 'excludeBookingId' | 'canSeeBookingNumbers'>,
  ): Promise<QuoteWarningDto[]> {
    const warnings: QuoteWarningDto[] = [];
    for (const s of sessions) {
      for (const p of s.physical) {
        const range = occupancyRange(
          s.times.startsAt,
          s.times.endsAt,
          p.setupBufferMin,
          p.cleanupBufferMin,
        );
        const taken = await tx.spaceOccupancy.findFirst({
          where: {
            tenantId: this.caller.tenantId,
            spaceId: p.id,
            active: true,
            startsAt: { lt: range.endsAt },
            endsAt: { gt: range.startsAt },
            ...(args.excludeBookingId
              ? { session: { bookingId: { not: args.excludeBookingId } } }
              : {}),
          },
          select: { session: { select: { booking: { select: { number: true } } } } },
        });
        if (taken) {
          warnings.push({
            code: 'SLOT_TAKEN',
            sessionIndex: s.index,
            detail: args.canSeeBookingNumbers ? (taken.session.booking.number ?? null) : null,
          });
          break;
        }
      }
    }
    return warnings;
  }
}
