import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { AVAILABILITY_MAX_DAYS } from '@venueos/shared';
import type { AvailabilityCellDto, AvailabilityDto, AvailabilityQuery } from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { FieldValidationError, NotFoundError } from '../../common/errors/domain-errors';
import { addDays, daysBetween, zonedInstant } from '../../common/time/zoned';
import { sessionTimes } from '../../booking/timing';
import { SPACE_WITH_COMPONENTS, expandPhysical } from '../bookings/core/quote-builder.service';
import { loadTenantContext } from '../bookings/core/support';

/**
 * The availability calendar (docs/01 module 6): for a venue and a date range, which space is held or confirmed in which slot
 * on which day. Free cells are not listed (the grid is spaces x dates x slots; anything not listed is free). Combined spaces
 * are aware of their components both ways, because the rows come from the same occupancy table the constraint guards: a
 * booking of Hall A+B blocks A and B, and a booking of A blocks A+B. Setup and cleanup buffers count (they are blocked too).
 * Drafts never block. No prices here.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
  ) {}

  async get(query: AvailabilityQuery): Promise<AvailabilityDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertAccess(query.venueId);
    const days = daysBetween(query.from, query.to) + 1;
    if (days > AVAILABILITY_MAX_DAYS) {
      throw new FieldValidationError(
        'to',
        `Ask for at most ${AVAILABILITY_MAX_DAYS} days at a time`,
      );
    }
    return this.tenantDb.tx(async (tx) => {
      const tenant = await loadTenantContext(tx, tenantId);
      const venue = await tx.venue.findFirst({
        where: { id: query.venueId, tenantId, active: true },
        select: { id: true, timezone: true },
      });
      if (!venue) throw new NotFoundError();
      const timezone = venue.timezone ?? tenant.timezone;

      const [spaces, slots] = await Promise.all([
        tx.space.findMany({
          where: { tenantId, venueId: venue.id, active: true },
          include: SPACE_WITH_COMPONENTS,
          orderBy: [{ isCombined: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        }),
        tx.slotTemplate.findMany({
          where: { tenantId, venueId: venue.id, active: true },
          orderBy: [{ startTime: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        }),
      ]);
      const physicalOf = new Map(spaces.map((s) => [s.id, expandPhysical(s)]));
      const physicalIds = [...new Set([...physicalOf.values()].flatMap((p) => p.map((x) => x.id)))];

      // Everything that blocks anywhere near the range (a session can start the evening before and end the next day).
      const windowStart = new Date(
        zonedInstant(query.from, '00:00', timezone).getTime() - 36 * 3_600_000,
      );
      const windowEnd = new Date(
        zonedInstant(addDays(query.to, 1), '00:00', timezone).getTime() + 36 * 3_600_000,
      );
      const occupancies = await tx.spaceOccupancy.findMany({
        where: {
          tenantId,
          active: true,
          spaceId: { in: physicalIds },
          startsAt: { lt: windowEnd },
          endsAt: { gt: windowStart },
        },
        select: {
          spaceId: true,
          startsAt: true,
          endsAt: true,
          session: {
            select: {
              id: true,
              booking: {
                select: {
                  id: true,
                  number: true,
                  status: true,
                  holdExpiresAt: true,
                  customer: { select: { name: true } },
                },
              },
              eventType: { select: { name: true } },
            },
          },
        },
      });
      const bySpace = new Map<string, typeof occupancies>();
      for (const o of occupancies) {
        const list = bySpace.get(o.spaceId) ?? [];
        list.push(o);
        bySpace.set(o.spaceId, list);
      }

      const cells: AvailabilityCellDto[] = [];
      for (let i = 0; i < days; i++) {
        const date = addDays(query.from, i);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        for (const slot of slots) {
          if (slot.daysOfWeek.length > 0 && !slot.daysOfWeek.includes(weekday)) continue;
          const window = sessionTimes(
            {
              mode: slot.mode,
              startTime: slot.startTime,
              endTime: slot.endTime,
              minHours: slot.minHours,
              defaultMinHours: tenant.settings.minHours,
            },
            date,
            timezone,
            {},
          );
          for (const space of spaces) {
            const entries = new Map<string, AvailabilityCellDto['entries'][number]>();
            for (const p of physicalOf.get(space.id) ?? []) {
              for (const o of bySpace.get(p.id) ?? []) {
                if (!(o.startsAt < window.endsAt && o.endsAt > window.startsAt)) continue;
                const b = o.session.booking;
                if (entries.has(o.session.id)) continue;
                entries.set(o.session.id, {
                  bookingId: b.id,
                  number: b.number,
                  status: b.status === 'TENTATIVE' ? 'HELD' : 'CONFIRMED',
                  customerName: b.customer.name,
                  sessionId: o.session.id,
                  eventTypeName: o.session.eventType?.name ?? null,
                  holdExpiresAt:
                    b.status === 'TENTATIVE' ? (b.holdExpiresAt?.toISOString() ?? null) : null,
                  blockedBy: p.id,
                });
              }
            }
            if (entries.size === 0) continue;
            const list = [...entries.values()];
            cells.push({
              spaceId: space.id,
              date,
              slotId: slot.id,
              status: list.some((e) => e.status === 'CONFIRMED') ? 'CONFIRMED' : 'HELD',
              entries: list,
            });
          }
        }
      }

      return {
        venueId: venue.id,
        from: query.from,
        to: query.to,
        timezone,
        spaces: spaces.map((s) => ({
          id: s.id,
          name: s.name,
          isCombined: s.isCombined,
          capacitySeated: s.capacitySeated ?? null,
          componentIds: s.isCombined ? s.components.map((c) => c.componentSpace.id) : [],
        })),
        slots: slots.map((s) => ({
          id: s.id,
          name: s.name,
          mode: s.mode,
          startTime: s.startTime,
          endTime: s.endTime,
          daysOfWeek: s.daysOfWeek,
        })),
        cells,
      };
    });
  }
}
