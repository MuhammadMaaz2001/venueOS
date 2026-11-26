import type { Prisma } from '@venueos/db';
import { money } from '@venueos/shared';
import type { LineItemDto, SessionDto, TaxRateSnapshotDto } from '@venueos/shared';
import { FrozenSessionPricingSchema } from '../../../pricing';
import { localDateOf } from '../../../common/time/zoned';
import { fmt, toLineDto } from './support';

/** The relations a session needs to be shown. */
export const SESSION_INCLUDE = {
  space: { select: { name: true } },
  slot: { select: { name: true, mode: true } },
  eventType: { select: { name: true } },
  package: { select: { name: true } },
} satisfies Prisma.BookingSessionInclude;
export type SessionRow = Prisma.BookingSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

export const BOOKING_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true, email: true } },
  venue: { select: { id: true, name: true, timezone: true } },
} satisfies Prisma.BookingInclude;

const hoursBetween = (start: Date, end: Date): string =>
  (Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100).toString();

/** A stored session as the API shows it. `index` is its position among the booking's sessions (cancelled ones included). */
export function sessionDto(
  row: SessionRow,
  index: number,
  timezone: string,
  currency: string,
  subtotal: string | null,
): SessionDto {
  const frozen = FrozenSessionPricingSchema.safeParse(row.pricing);
  const prices = frozen.success ? frozen.data : null;
  const selections = Array.isArray(row.addOns)
    ? (row.addOns as { addOnId?: unknown; quantity?: unknown }[]).filter(
        (a): a is { addOnId: string; quantity: number } =>
          typeof a.addOnId === 'string' && typeof a.quantity === 'number',
      )
    : [];
  const minGuests = prices?.package?.minGuests ?? 0;
  return {
    id: row.id,
    index,
    status: row.status,
    spaceId: row.spaceId,
    spaceName: row.space.name,
    date: localDateOf(row.startsAt, timezone),
    slotId: row.slotId ?? '',
    slotName: row.slot?.name ?? '',
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    hours: hoursBetween(row.startsAt, row.endsAt),
    eventTypeId: row.eventTypeId,
    eventTypeName: row.eventType?.name ?? null,
    packageId: row.packageId,
    packageName: row.package?.name ?? null,
    guests: row.guests,
    guaranteedGuests: row.guaranteedGuests,
    billedGuests: Math.max(row.guests, minGuests, row.guaranteedGuests ?? 0),
    addOns: selections.map((a) => ({
      addOnId: a.addOnId,
      name: prices?.addOns.find((p) => p.id === a.addOnId)?.name ?? '',
      quantity: a.quantity,
    })),
    setupNotes: row.setupNotes,
    kitchenNotes: row.kitchenNotes,
    subtotal: subtotal === null ? null : fmt(subtotal, currency),
  };
}

export interface LineRow {
  id: string;
  sessionId: string | null;
  kind: LineItemDto['kind'];
  description: string;
  refType: string | null;
  refId: string | null;
  quantity: { toString(): string };
  unitPrice: { toString(): string };
  amount: { toString(): string };
  taxAmount: { toString(): string };
  sortOrder: number;
}

/** Lines of a booking as the API shows them, with their sessions' positions. */
export function lineDtos(
  rows: readonly LineRow[],
  sessionIndexById: ReadonlyMap<string, number>,
  currency: string,
  visible: boolean,
): LineItemDto[] {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) =>
      toLineDto(
        {
          id: r.id,
          sessionIndex: r.sessionId === null ? null : (sessionIndexById.get(r.sessionId) ?? null),
          kind: r.kind,
          description: r.description,
          refType: r.refType,
          refId: r.refId,
          quantity: r.quantity,
          unitPrice: r.unitPrice,
          amount: r.amount,
          taxAmount: r.taxAmount,
        },
        currency,
        visible,
      ),
    );
}

/** Sum of the amounts of the lines of each session (by session id). */
export function sessionSubtotalsById(rows: readonly LineRow[]): Map<string, string> {
  const sums = new Map<string, ReturnType<typeof money>>();
  for (const r of rows) {
    if (r.sessionId === null) continue;
    sums.set(r.sessionId, (sums.get(r.sessionId) ?? money('0')).plus(r.amount.toString()));
  }
  return new Map([...sums].map(([id, sum]) => [id, sum.toString()]));
}

export type PricingJson = {
  taxRate: TaxRateSnapshotDto | null;
  discount: { type: 'PERCENT' | 'AMOUNT'; value: string } | null;
};

/** The frozen tax rate and discount of a booking (`bookings.pricing`), defensively parsed. */
export function readBookingPricing(raw: unknown): PricingJson {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PricingJson>;
  const tax = value.taxRate;
  const discount = value.discount;
  return {
    taxRate:
      tax &&
      typeof tax.id === 'string' &&
      typeof tax.ratePct === 'string' &&
      typeof tax.inclusive === 'boolean'
        ? {
            id: tax.id,
            name: String(tax.name ?? ''),
            ratePct: tax.ratePct,
            inclusive: tax.inclusive,
          }
        : null,
    discount:
      discount &&
      (discount.type === 'PERCENT' || discount.type === 'AMOUNT') &&
      typeof discount.value === 'string'
        ? { type: discount.type, value: discount.value }
        : null,
  };
}
