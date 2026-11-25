import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { formatMoney, money, parseTenantSettings } from '@venueos/shared';
import type { RentPreviewDto, RentPreviewQuery } from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import {
  FieldValidationError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain-errors';
import { applyPriceRules, baseRent, weekdayOf } from '../../pricing';
import type { PricingRule } from '../../pricing';

const dateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

/**
 * What a space costs for one slot on one day (docs/05 section 3, steps 1 and 2): the base rent, each price rule that
 * applies in the order it is applied, and the final rent. Read-only; the quotation engine (module 5) uses the same pure
 * functions (`src/pricing`), so this is what a quotation will charge for the rent.
 */
@Injectable()
export class RentPreviewService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly venueScope: VenueScope,
    private readonly caller: Caller,
  ) {}

  async preview(query: RentPreviewQuery): Promise<RentPreviewDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertAccess(query.venueId);
    return this.tenantDb.tx(async (tx) => {
      // The ids come from the client: every one is loaded in this tenant, and space and slot must belong to the venue.
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { currency: true, settings: true },
      });
      if (!tenant) throw new NotFoundError();
      const venue = await tx.venue.findFirst({
        where: { id: query.venueId, tenantId },
        select: { id: true },
      });
      const space = await tx.space.findFirst({
        where: { id: query.spaceId, tenantId, venueId: query.venueId },
        select: { id: true, baseRent: true, active: true },
      });
      const slot = await tx.slotTemplate.findFirst({
        where: { id: query.slotId, tenantId, venueId: query.venueId },
        select: { id: true, mode: true, daysOfWeek: true, minHours: true, active: true },
      });
      if (!venue || !space || !slot) throw new NotFoundError();
      if (!space.active) throw new FieldValidationError('spaceId', 'This space is inactive');
      if (!slot.active) throw new FieldValidationError('slotId', 'This slot is inactive');

      const weekday = weekdayOf(query.date);
      if (slot.daysOfWeek.length > 0 && !slot.daysOfWeek.includes(weekday)) {
        throw new FieldValidationError('date', 'This slot is not offered on that day of the week');
      }

      let hours: string | null = null;
      if (slot.mode === 'HOURLY') {
        if (query.hours === undefined) {
          throw new FieldValidationError('hours', 'Hours are needed for an hourly slot');
        }
        const minimum = slot.minHours ?? parseTenantSettings(tenant.settings).minHours;
        const booked = money(query.hours);
        if (booked.lt(minimum) || booked.gt(24)) {
          throw new FieldValidationError('hours', `Hours must be between ${minimum} and 24`);
        }
        hours = booked.toString();
      } else if (query.hours !== undefined) {
        throw new FieldValidationError('hours', 'Only hourly slots have hours');
      }

      const slotPrice = await tx.spaceSlotPrice.findFirst({
        where: { tenantId, spaceId: space.id, slotId: slot.id },
        select: { rent: true },
      });
      const unit = slotPrice?.rent ?? space.baseRent;
      if (unit === null || unit === undefined) {
        throw new InvalidStateTransitionError('No rent is set for this space and slot yet.');
      }

      const rows = await tx.priceRule.findMany({
        where: {
          tenantId,
          active: true,
          OR: [{ spaceId: null }, { spaceId: space.id }],
          AND: [{ OR: [{ slotId: null }, { slotId: slot.id }] }],
        },
      });
      const rules: PricingRule[] = rows.map((r) => ({
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

      const currency = tenant.currency;
      const base = baseRent(unit.toString(), hours, currency);
      const result = applyPriceRules({
        baseRent: base,
        currency,
        rules,
        context: { spaceId: space.id, slotId: slot.id, date: query.date },
      });
      const text = (v: { toString(): string }) => formatMoney(v.toString(), currency);

      return {
        currency,
        venueId: query.venueId,
        spaceId: space.id,
        slotId: slot.id,
        date: query.date,
        weekday,
        slotMode: slot.mode,
        hours,
        unitRent: text(unit),
        baseSource: slotPrice ? 'SLOT_PRICE' : 'SPACE_BASE_RENT',
        baseRent: text(result.baseRent),
        adjustments: result.applied.map((a) => ({
          ruleId: a.rule.id,
          name: a.rule.name,
          kind: a.rule.kind,
          adjustment: a.rule.adjustment,
          value:
            a.rule.adjustment === 'PERCENT'
              ? money(a.rule.value).toString()
              : formatMoney(a.rule.value, currency),
          amount: text(a.amount),
          rentAfter: text(a.rentAfter),
        })),
        notApplied: result.notApplied.map((r) => ({ ruleId: r.id, name: r.name })),
        finalRent: text(result.finalRent),
      };
    });
  }
}
