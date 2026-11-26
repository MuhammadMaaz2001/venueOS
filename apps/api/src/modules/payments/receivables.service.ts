import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { allocateFifo, formatMoney, money } from '@venueos/shared';
import type {
  ReceivableDto,
  ReceivablesQuery,
  ReceivablesResponse,
  ReceivablesSummaryDto,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { FieldValidationError } from '../../common/errors/domain-errors';
import { addDays, daysBetween, localDateOf } from '../../common/time/zoned';
import { loadTenantContext } from '../bookings/core/support';

const encodeCursor = (offset: number): string =>
  Buffer.from(`o1:${offset}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const n = decoded.startsWith('o1:') ? Number(decoded.slice(3)) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new FieldValidationError('cursor', 'Invalid cursor');
  return n;
}

interface Row extends ReceivableDto {
  /** Remaining amounts of the items due within the next 7 days that are not overdue yet. */
  dueWeekAmount: string;
  dueWeekItems: number;
}

/**
 * Receivables (docs/01 module 9): confirmed and completed bookings that still owe money, overdue first. What is owed per
 * schedule item comes from the FIFO allocation of the booking's cleared net receipts (`bookings.paid_total`, kept by the
 * ledger). Held bookings are not receivables yet: their token and advance are what confirmation waits for. Computed in
 * memory over the workspace's open bookings, which is small by nature (a venue has a few hundred live bookings).
 */
@Injectable()
export class ReceivablesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
  ) {}

  private async rows(tx: DbTx, venueId?: string): Promise<{ currency: string; rows: Row[] }> {
    const tenantId = this.caller.tenantId;
    const tenant = await loadTenantContext(tx, tenantId);
    const ids = this.venueScope.filterIds(venueId ? [venueId] : undefined);
    const bookings = await tx.booking.findMany({
      where: {
        tenantId,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        ...(ids ? { venueId: { in: ids } } : {}),
      },
      select: {
        id: true,
        number: true,
        status: true,
        venueId: true,
        currency: true,
        grandTotal: true,
        paidTotal: true,
        venue: { select: { name: true, timezone: true } },
        customer: { select: { id: true, name: true, phone: true } },
        sessions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'asc' },
          take: 1,
          select: { startsAt: true },
        },
      },
    });
    const owing = bookings.filter((b) => money(b.grandTotal.toString()).gt(b.paidTotal.toString()));
    const items = await tx.paymentScheduleItem.findMany({
      where: { tenantId, bookingId: { in: owing.map((b) => b.id) } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const byBooking = new Map<string, typeof items>();
    for (const item of items) {
      const list = byBooking.get(item.bookingId) ?? [];
      list.push(item);
      byBooking.set(item.bookingId, list);
    }
    const rows: Row[] = owing.map((b) => {
      const currency = b.currency;
      const zone = b.venue.timezone ?? tenant.timezone;
      const today = localDateOf(new Date(), zone);
      const weekEnd = addDays(today, 6);
      const mine = byBooking.get(b.id) ?? [];
      const allocation = allocateFifo(
        mine.map((i, position) => ({
          id: i.id,
          dueDate: i.dueDate.toISOString().slice(0, 10),
          amount: i.amount.toString(),
          position,
        })),
        b.paidTotal.toString(),
        today,
      );
      const states = new Map(allocation.items.map((s) => [s.id, s]));
      const open = mine
        .map((i) => ({ item: i, state: states.get(i.id) }))
        .filter((x) => x.state && money(x.state.remaining).gt(0));
      const overdue = open.filter((x) => x.state?.status === 'OVERDUE');
      const week = open.filter((x) => {
        const due = x.item.dueDate.toISOString().slice(0, 10);
        return x.state?.status !== 'OVERDUE' && due >= today && due <= weekEnd;
      });
      const sum = (list: typeof open) =>
        list.reduce((s, x) => s.plus(x.state?.remaining ?? '0'), money('0'));
      const next = open[0];
      const oldest = overdue[0];
      return {
        bookingId: b.id,
        number: b.number,
        status: b.status,
        venueId: b.venueId,
        venueName: b.venue.name,
        customer: { id: b.customer.id, name: b.customer.name, phone: b.customer.phone },
        firstSessionAt: b.sessions[0]?.startsAt.toISOString() ?? null,
        grandTotal: formatMoney(b.grandTotal.toString(), currency),
        paidTotal: formatMoney(b.paidTotal.toString(), currency),
        balanceDue: formatMoney(
          money(b.grandTotal.toString()).minus(b.paidTotal.toString()).toString(),
          currency,
        ),
        nextDueDate: next ? next.item.dueDate.toISOString().slice(0, 10) : null,
        nextDueAmount: next && next.state ? formatMoney(next.state.remaining, currency) : null,
        overdueAmount: formatMoney(sum(overdue).toString(), currency),
        overdueDays: oldest
          ? daysBetween(oldest.item.dueDate.toISOString().slice(0, 10), today)
          : null,
        dueWeekAmount: formatMoney(sum(week).toString(), currency),
        dueWeekItems: week.length,
      };
    });
    return { currency: tenant.currency, rows };
  }

  async list(query: ReceivablesQuery): Promise<ReceivablesResponse> {
    const { currency, rows } = await this.tenantDb.tx((tx) => this.rows(tx, query.venueId));
    let list = rows;
    if (query.overdue === 'true') list = list.filter((r) => money(r.overdueAmount).gt(0));
    if (query.from)
      list = list.filter((r) => r.nextDueDate !== null && r.nextDueDate >= (query.from as string));
    if (query.to)
      list = list.filter((r) => r.nextDueDate !== null && r.nextDueDate <= (query.to as string));
    // Overdue first (the longest overdue first), then by the next due date, then by number.
    list.sort(
      (a, b) =>
        (b.overdueDays ?? -1) - (a.overdueDays ?? -1) ||
        (a.nextDueDate ?? '9999-12-31').localeCompare(b.nextDueDate ?? '9999-12-31') ||
        (a.number ?? '').localeCompare(b.number ?? ''),
    );
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const page = list.slice(offset, offset + query.limit);
    return {
      currency,
      data: page.map((row) => {
        const { dueWeekAmount, dueWeekItems, ...dto } = row;
        void dueWeekAmount;
        void dueWeekItems;
        return dto;
      }),
      nextCursor: offset + query.limit < list.length ? encodeCursor(offset + query.limit) : null,
    };
  }

  async summary(): Promise<ReceivablesSummaryDto> {
    const { currency, rows } = await this.tenantDb.tx((tx) => this.rows(tx));
    const total = (values: readonly string[]) =>
      formatMoney(values.reduce((s, v) => s.plus(v), money('0')).toString(), currency);
    const overdue = rows.filter((r) => money(r.overdueAmount).gt(0));
    const week = rows.filter((r) => r.dueWeekItems > 0);
    return {
      currency,
      dueThisWeek: { count: week.length, amount: total(week.map((r) => r.dueWeekAmount)) },
      overdue: { count: overdue.length, amount: total(overdue.map((r) => r.overdueAmount)) },
      outstanding: { count: rows.length, amount: total(rows.map((r) => r.balanceDue)) },
    };
  }
}
