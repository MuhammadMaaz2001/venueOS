import { Injectable } from '@nestjs/common';
import type { DbTx } from '@venueos/db';
import { clearedNet, formatMoney, money } from '@venueos/shared';
import type { LedgerRow } from '@venueos/shared';

/**
 * The payments ledger of a booking (docs/03 "Paid total", docs/05 section 5). The rows are append-only; what they add up to is
 * computed here and written to `bookings.paid_total` in the SAME transaction that changes a payment (docs/04 section 7), never
 * patched anywhere else. Only CLEARED entries count: a pending or bounced cheque never does.
 */
@Injectable()
export class PaymentsLedger {
  async rows(tx: DbTx, tenantId: string, bookingId: string): Promise<LedgerRow[]> {
    const payments = await tx.payment.findMany({
      where: { tenantId, bookingId },
      select: { id: true, entryType: true, status: true, amount: true, reversesId: true },
    });
    return payments.map((p) => ({
      id: p.id,
      entryType: p.entryType,
      status: p.status,
      amount: p.amount.toString(),
      reversesId: p.reversesId,
    }));
  }

  /** Cleared net receipts of the booking (CLEARED receipts - CLEARED refunds, reversals applied). */
  async net(tx: DbTx, tenantId: string, bookingId: string): Promise<string> {
    return clearedNet(await this.rows(tx, tenantId, bookingId));
  }

  /** Writes `bookings.paid_total` (the cleared net) and returns it. Does not bump the booking's `rev`. */
  async refreshPaidTotal(
    tx: DbTx,
    tenantId: string,
    bookingId: string,
    currency: string,
  ): Promise<string> {
    const net = formatMoney(await this.net(tx, tenantId, bookingId), currency);
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, tenantId },
      data: { paidTotal: net },
    });
    if (updated.count !== 1) throw new Error('refreshPaidTotal: the booking is gone');
    return net;
  }

  /** Cheques received that have not cleared yet: shown next to the paid total, never part of it. */
  async pendingCheques(tx: DbTx, tenantId: string, bookingId: string): Promise<string> {
    const rows = await tx.payment.findMany({
      where: { tenantId, bookingId, entryType: 'RECEIPT', status: 'PENDING' },
      select: { amount: true },
    });
    return rows.reduce((sum, r) => sum.plus(r.amount.toString()), money('0')).toString();
  }
}
