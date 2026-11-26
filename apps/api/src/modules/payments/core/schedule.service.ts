import { Injectable } from '@nestjs/common';
import type { DbTx } from '@venueos/db';
import {
  allocateFifo,
  formatMoney,
  generateSchedule,
  money,
  scheduleMatchesTotal,
} from '@venueos/shared';
import type { Allocation, ScheduleItemDraft, ScheduleItemDto } from '@venueos/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { localDateOf } from '../../../common/time/zoned';
import type { TenantContext } from '../../bookings/core/support';

export interface ScheduleBooking {
  id: string;
  venueId: string;
  currency: string;
  grandTotal: string;
  holdExpiresAt: Date | null;
}

const DATE_ONLY = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The payment schedule of a booking (docs/05 section 5): Token, Advance and Balance from the workspace settings, generated
 * when the slot is held (and again at confirmation if there is none), regenerated when a new quote version changes the total,
 * editable by staff as long as the items add up to the grand total. What is paid is never stored per item: the cleared receipts
 * are applied in due-date order (FIFO) whenever it is read.
 */
@Injectable()
export class PaymentSchedule {
  constructor(private readonly audit: AuditService) {}

  async items(tx: DbTx, tenantId: string, bookingId: string) {
    return tx.paymentScheduleItem.findMany({
      where: { tenantId, bookingId },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** The items with their FIFO state against `receivedNet`, and the allocation totals. */
  async view(
    tx: DbTx,
    tenantId: string,
    bookingId: string,
    currency: string,
    receivedNet: string,
    today: string,
  ): Promise<{ items: ScheduleItemDto[]; allocation: Allocation }> {
    const rows = await this.items(tx, tenantId, bookingId);
    const allocation = allocateFifo(
      rows.map((r, position) => ({
        id: r.id,
        dueDate: DATE_ONLY(r.dueDate),
        amount: r.amount.toString(),
        position,
      })),
      receivedNet,
      today,
    );
    const byId = new Map(allocation.items.map((i) => [i.id, i]));
    return {
      allocation,
      items: rows.map((r) => {
        const state = byId.get(r.id);
        return {
          id: r.id,
          label: r.label,
          dueDate: DATE_ONLY(r.dueDate),
          amount: formatMoney(r.amount.toString(), currency),
          allocated: formatMoney(state?.allocated ?? '0', currency),
          remaining: formatMoney(state?.remaining ?? '0', currency),
          status: state?.status ?? 'UNPAID',
          reminded: r.reminded,
        };
      }),
    };
  }

  private async firstSessionDate(
    tx: DbTx,
    tenantId: string,
    booking: ScheduleBooking,
    tenant: TenantContext,
  ): Promise<string | null> {
    const first = await tx.bookingSession.findFirst({
      where: { bookingId: booking.id, tenantId, status: 'ACTIVE' },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true },
    });
    if (!first) return null;
    const venue = await tx.venue.findFirst({
      where: { id: booking.venueId, tenantId },
      select: { timezone: true },
    });
    return localDateOf(first.startsAt, venue?.timezone ?? tenant.timezone);
  }

  /**
   * Replaces the items with the ones the settings give. `today` is the day the token is due, `advanceDue` the advance's due
   * day (the end of the hold). A reminder already sent for an item that comes back unchanged (same label and day) is kept.
   */
  async generate(
    tx: DbTx,
    tenant: TenantContext,
    booking: ScheduleBooking,
    options: { today: string; advanceDue: string | null; action: string },
  ): Promise<void> {
    const tenantId = tenant.id;
    const before = await this.items(tx, tenantId, booking.id);
    const drafts = generateSchedule({
      grandTotal: booking.grandTotal,
      currency: booking.currency,
      tokenAmount: tenant.settings.tokenAmount,
      advancePct: tenant.settings.advancePct,
      balanceDueDays: tenant.settings.balanceDueDays,
      today: options.today,
      advanceDue: options.advanceDue,
      firstSessionDate: await this.firstSessionDate(tx, tenantId, booking, tenant),
    });
    await this.write(tx, tenantId, booking, before, drafts, options.action);
  }

  /** Generates the schedule when the booking has none (the hold, or a confirmation that skipped it). */
  async ensure(tx: DbTx, tenant: TenantContext, booking: ScheduleBooking): Promise<void> {
    const count = await tx.paymentScheduleItem.count({
      where: { tenantId: tenant.id, bookingId: booking.id },
    });
    if (count > 0) return;
    const today = localDateOf(new Date(), tenant.timezone);
    await this.generate(tx, tenant, booking, {
      today,
      advanceDue: booking.holdExpiresAt
        ? localDateOf(booking.holdExpiresAt, tenant.timezone)
        : today,
      action: 'payment_schedule.generate',
    });
  }

  /**
   * A new quote version changed the total: the items no longer add up, so they are generated again from the settings, keeping
   * the dates the schedule already had (a confirmed booking must not turn its token overdue because it was re-priced).
   */
  async onRequote(tx: DbTx, tenant: TenantContext, booking: ScheduleBooking): Promise<void> {
    const rows = await this.items(tx, tenant.id, booking.id);
    if (rows.length === 0) return;
    if (
      scheduleMatchesTotal(
        rows.map((r) => ({ amount: r.amount.toString() })),
        booking.grandTotal,
      )
    )
      return;
    const first = rows[0] as (typeof rows)[number];
    const advance = rows.find((r) => r.label === 'Advance');
    await this.generate(tx, tenant, booking, {
      today: DATE_ONLY(first.dueDate),
      advanceDue: advance ? DATE_ONLY(advance.dueDate) : null,
      action: 'payment_schedule.regenerate',
    });
  }

  /** Staff replace the whole schedule: the caller has checked that it adds up to the grand total. */
  async replace(
    tx: DbTx,
    tenant: TenantContext,
    booking: ScheduleBooking,
    drafts: readonly ScheduleItemDraft[],
  ): Promise<void> {
    const before = await this.items(tx, tenant.id, booking.id);
    await this.write(tx, tenant.id, booking, before, drafts, 'payment_schedule.update');
  }

  private async write(
    tx: DbTx,
    tenantId: string,
    booking: ScheduleBooking,
    before: Awaited<ReturnType<PaymentSchedule['items']>>,
    drafts: readonly ScheduleItemDraft[],
    action: string,
  ): Promise<void> {
    const reminded = new Set(
      before.filter((b) => b.reminded).map((b) => `${b.label}|${DATE_ONLY(b.dueDate)}`),
    );
    await tx.paymentScheduleItem.deleteMany({ where: { tenantId, bookingId: booking.id } });
    // One by one: the order of creation is the tie-break of items due the same day.
    for (const d of drafts) {
      await tx.paymentScheduleItem.create({
        data: {
          tenantId,
          bookingId: booking.id,
          label: d.label,
          dueDate: new Date(`${d.dueDate}T00:00:00Z`),
          amount: d.amount,
          reminded: reminded.has(`${d.label}|${d.dueDate}`),
        },
      });
    }
    const show = (items: readonly { label: string; dueDate: string; amount: string }[]) =>
      items.map((i) => `${i.label} ${i.amount} due ${i.dueDate}`);
    await this.audit.record(tx, {
      action,
      entityType: 'booking',
      entityId: booking.id,
      venueId: booking.venueId,
      before: {
        grandTotal: booking.grandTotal,
        items: show(
          before.map((b) => ({
            label: b.label,
            dueDate: DATE_ONLY(b.dueDate),
            amount: formatMoney(b.amount.toString(), booking.currency),
          })),
        ),
      },
      after: { grandTotal: booking.grandTotal, items: show(drafts) },
    });
    void money;
  }
}
