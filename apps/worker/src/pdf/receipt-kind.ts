import { JobQueue, enqueueEmail } from '@venueos/db';
import { formatMoney, money } from '@venueos/shared';
import type { ReceiptPdfVars } from '@venueos/templates';
import { date, group } from './format';
import type { PdfKindHandler } from './pdf-kind';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  CARD: 'Card',
  MOBILE_WALLET: 'Mobile wallet',
  ONLINE_GATEWAY: 'Online',
};

/**
 * `receipt` (module 9): the PDF of one receipt. It shows the payment and where the booking stands now (total, paid to date,
 * balance); a pending cheque says it has not cleared, a reversed receipt is marked cancelled. The key is recorded in
 * `receipt_files` (a table of its own: `payments` is append-only, so its rows cannot carry it).
 *
 * When the PDF of a CLEARED receipt is saved, the customer's email with the PDF attached is queued in the same transaction
 * (once per payment: the payment row is locked and the message log is checked, so two renders of the same receipt, for example
 * the one at entry and the one after a cheque cleared, send one email). A pending cheque is emailed when it clears. "Resend" is
 * the API's own, explicit action.
 */
export function createReceiptKind(queue: JobQueue): PdfKindHandler {
  return {
    kind: 'receipt',
    template: 'receipt',

    async load(tx, payload) {
      const p = await tx.payment.findFirst({
        where: { id: payload.entityId, tenantId: payload.tenantId, entryType: 'RECEIPT' },
        include: {
          booking: {
            include: {
              customer: { select: { name: true, phone: true, preferredLocale: true } },
              venue: { select: { name: true, timezone: true } },
            },
          },
        },
      });
      if (!p || !p.receiptNo) return null;
      const tenant = await tx.tenant.findFirst({
        where: { id: payload.tenantId },
        select: { name: true, timezone: true, defaultLocale: true },
      });
      if (!tenant) return null;
      const reversal = await tx.payment.findFirst({
        where: { tenantId: payload.tenantId, reversesId: p.id },
        select: { receivedAt: true },
      });
      const zone = p.booking.venue.timezone ?? tenant.timezone;
      const currency = p.booking.currency;
      const total = money(p.booking.grandTotal.toString());
      const paid = money(p.booking.paidTotal.toString());
      const owed = total.gt(paid) ? total.minus(paid) : money('0');
      const text = (v: { toString(): string }): string =>
        group(formatMoney(v.toString(), currency));
      const vars: ReceiptPdfVars = {
        tenantName: tenant.name,
        receiptNo: p.receiptNo,
        receivedOn: date(p.receivedAt, zone),
        customer: { name: p.booking.customer.name, phone: p.booking.customer.phone },
        venueName: p.booking.venue.name,
        bookingNumber: p.booking.number ?? '',
        currency,
        amount: text(p.amount),
        method: METHOD_LABEL[p.method] ?? p.method,
        reference: p.reference,
        status:
          p.status === 'CLEARED'
            ? 'Received'
            : p.status === 'PENDING'
              ? 'Cheque received: not cleared yet'
              : 'Cheque returned',
        notes: p.notes,
        bookingTotal: text(total),
        paidToDate: text(paid),
        balanceDue: text(owed),
        voidNote: reversal
          ? `Cancelled: reversed on ${date(reversal.receivedAt, zone)}`
          : p.status === 'BOUNCED'
            ? 'Cancelled: the cheque was returned'
            : null,
      };
      return {
        locale: p.booking.customer.preferredLocale ?? tenant.defaultLocale,
        vars: vars as unknown as Record<string, unknown>,
      };
    },

    async saveKey(tx, payload, key) {
      const { tenantId, entityId: paymentId } = payload;
      // One render at a time per payment decides whether the email goes out.
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} AND tenant_id = ${tenantId} FOR UPDATE`;
      await tx.receiptFile.upsert({
        where: { paymentId },
        create: { tenantId, paymentId, pdfKey: key },
        update: { pdfKey: key },
      });
      const p = await tx.payment.findFirst({
        where: { id: paymentId, tenantId },
        include: {
          booking: {
            include: {
              customer: { select: { name: true, email: true, preferredLocale: true } },
              venue: { select: { timezone: true } },
            },
          },
          reversedBy: { select: { id: true } },
        },
      });
      if (!p || !p.receiptNo || p.status !== 'CLEARED' || p.reversedBy) return;
      const to = p.booking.customer.email;
      if (!to) return;
      const already = await tx.messageLog.findFirst({
        where: { tenantId, entityType: 'payment', entityId: paymentId, event: 'receipt.sent' },
        select: { id: true },
      });
      if (already) return;
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true, timezone: true, defaultLocale: true },
      });
      if (!tenant) return;
      const zone = p.booking.venue.timezone ?? tenant.timezone;
      await enqueueEmail(queue, tx, tenantId, {
        to,
        template: 'receipt.sent',
        locale: p.booking.customer.preferredLocale ?? tenant.defaultLocale,
        event: 'receipt.sent',
        entityType: 'payment',
        entityId: paymentId,
        attachments: [{ key, filename: `${p.receiptNo}.pdf` }],
        vars: {
          customerName: p.booking.customer.name,
          tenantName: tenant.name,
          receiptNo: p.receiptNo,
          amount: `${p.booking.currency} ${group(formatMoney(p.amount.toString(), p.booking.currency))}`,
          method: METHOD_LABEL[p.method] ?? p.method,
          receivedOn: date(p.receivedAt, zone),
          bookingNumber: p.booking.number ?? '',
        },
      });
    },
  };
}
