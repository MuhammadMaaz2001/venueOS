import { Injectable } from '@nestjs/common';
import { JobQueue, TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import {
  JOB_NAMES,
  formatMoney,
  money,
  pdfObjectKey,
  readyToConfirm,
  scheduleMatchesTotal,
} from '@venueos/shared';
import type {
  BouncePaymentInput,
  PaymentDto,
  PaymentsOverviewDto,
  ReceiptLinkDto,
  RecordPaymentInput,
  ReplaceScheduleInput,
  ResendReceiptInput,
  ReversePaymentInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  FieldValidationError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain-errors';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { clientMoney } from '../../common/money/tenant-money';
import { PresignService } from '../../common/storage/presign.service';
import { localDateOf } from '../../common/time/zoned';
import { loadTenantContext, nextNumber } from '../bookings/core/support';
import type { TenantContext } from '../bookings/core/support';
import { PaymentsLedger } from './core/ledger.service';
import { PaymentSchedule } from './core/schedule.service';
import { PAYMENT_INCLUDE, paymentDto, refundDto, REFUND_INCLUDE } from './core/views';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  CARD: 'Card',
  MOBILE_WALLET: 'Mobile wallet',
  ONLINE_GATEWAY: 'Online',
};

const PAYABLE_STATUSES = ['TENTATIVE', 'CONFIRMED', 'COMPLETED'] as const;
const BOOKING_LOAD = {
  include: {
    customer: { select: { id: true, name: true, email: true, preferredLocale: true } },
    venue: { select: { timezone: true } },
  },
} satisfies Prisma.BookingDefaultArgs;
export type PayableBooking = Prisma.BookingGetPayload<typeof BOOKING_LOAD>;

/**
 * Payments of a booking (docs/05 section 5, docs/04 section 7): record a receipt (a cheque starts PENDING), clear or bounce a
 * cheque, reverse a wrong entry, the receipt PDF and e-mail, and the Payments tab (schedule, totals, entries). Every change
 * keeps `bookings.paid_total` in step in the same transaction, is audited, and a created payment needs an `Idempotency-Key`
 * (a retry returns the first result). Entries are never edited: only `status` / `cleared_at` of a cheque move.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly audit: AuditService,
    private readonly ledger: PaymentsLedger,
    private readonly schedule: PaymentSchedule,
    private readonly jobQueue: JobQueue,
    private readonly emailOutbox: EmailOutbox,
    private readonly presign: PresignService,
  ) {}

  private scope(): Prisma.BookingWhereInput {
    const ids = this.venueScope.filterIds();
    return ids ? { venueId: { in: ids } } : {};
  }

  /** The booking, inside the caller's venues: another venue or workspace is 404. */
  async loadBooking(tx: DbTx, id: string): Promise<PayableBooking> {
    const b = await tx.booking.findFirst({
      where: { id, tenantId: this.caller.tenantId, ...this.scope() },
      ...BOOKING_LOAD,
    });
    if (!b) throw new NotFoundError();
    return b;
  }

  private async loadPayment(tx: DbTx, id: string) {
    const row = await tx.payment.findFirst({
      where: { id, tenantId: this.caller.tenantId, booking: this.scope() },
      include: { ...PAYMENT_INCLUDE, booking: BOOKING_LOAD },
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  // ───────────────────────────── the Payments tab ─────────────────────────────

  async overview(bookingId: string): Promise<PaymentsOverviewDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadBooking(tx, bookingId);
      const tenant = await loadTenantContext(tx, tenantId);
      return this.buildOverview(tx, b, tenant);
    });
  }

  async buildOverview(
    tx: DbTx,
    b: PayableBooking,
    tenant: TenantContext,
  ): Promise<PaymentsOverviewDto> {
    const tenantId = tenant.id;
    const currency = b.currency;
    const net = await this.ledger.net(tx, tenantId, b.id);
    const today = localDateOf(new Date(), b.venue.timezone ?? tenant.timezone);
    const { items, allocation } = await this.schedule.view(
      tx,
      tenantId,
      b.id,
      currency,
      net,
      today,
    );
    const pending = await this.ledger.pendingCheques(tx, tenantId, b.id);
    const rows = await tx.payment.findMany({
      where: { tenantId, bookingId: b.id },
      include: PAYMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const refunds = await tx.refundRequest.findMany({
      where: { tenantId, bookingId: b.id },
      include: REFUND_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const open = refunds
      .filter((r) => r.status === 'REQUESTED' || r.status === 'APPROVED')
      .reduce((sum, r) => sum.plus(r.amount.toString()), money('0'));
    const total = money(b.grandTotal.toString());
    const required = total.times(String(tenant.settings.advancePct)).div(100);
    const paid = money(net);
    const refundable = paid.minus(open);
    const fmt = (v: { toString(): string }) => formatMoney(v.toString(), currency);
    void allocation;
    return {
      bookingId: b.id,
      bookingNumber: b.number,
      bookingStatus: b.status,
      currency,
      summary: {
        grandTotal: fmt(total),
        paidTotal: fmt(paid),
        pendingCheques: fmt(pending),
        credit: fmt(paid.gt(total) ? paid.minus(total) : money('0')),
        balanceDue: fmt(total.gt(paid) ? total.minus(paid) : money('0')),
        advancePct: tenant.settings.advancePct,
        advanceRequired: fmt(required),
        advanceMet: paid.gte(required),
        readyToConfirm: readyToConfirm(
          b.status,
          net,
          b.grandTotal.toString(),
          tenant.settings.advancePct,
        ),
        suggestedRefund:
          b.status === 'CANCELLED' && b.suggestedRefund !== null
            ? fmt(b.suggestedRefund.toString())
            : null,
        refundable: fmt(refundable.gt(0) ? refundable : money('0')),
      },
      schedule: items,
      payments: rows.map((r) => paymentDto(r, currency)),
      refundRequests: refunds.map((r) => refundDto(r)),
    };
  }

  // ───────────────────────────── the schedule ─────────────────────────────

  /** Staff replace the schedule; the items must add up to the grand total (docs/05 section 5). */
  async replaceSchedule(
    bookingId: string,
    input: ReplaceScheduleInput,
  ): Promise<PaymentsOverviewDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadBooking(tx, bookingId);
      if (b.status !== 'TENTATIVE' && b.status !== 'CONFIRMED') {
        throw new InvalidStateTransitionError(
          'The schedule can be changed while the slot is held or the booking is confirmed.',
        );
      }
      const tenant = await loadTenantContext(tx, tenantId);
      const drafts = input.items.map((item, i) => {
        const amount = clientMoney(item.amount, b.currency, `items.${i}.amount`);
        if (!money(amount).gt(0))
          throw new FieldValidationError(`items.${i}.amount`, 'An amount must be above zero');
        return { label: item.label, dueDate: item.dueDate, amount };
      });
      if (!scheduleMatchesTotal(drafts, b.grandTotal.toString())) {
        throw new FieldValidationError(
          'items',
          'The items must add up to the grand total of the booking',
        );
      }
      await this.schedule.replace(
        tx,
        tenant,
        {
          id: b.id,
          venueId: b.venueId,
          currency: b.currency,
          grandTotal: b.grandTotal.toString(),
          holdExpiresAt: b.holdExpiresAt,
        },
        drafts,
      );
      return this.buildOverview(tx, b, tenant);
    });
  }

  // ───────────────────────────── recording ─────────────────────────────

  private sameReceipt(
    existing: {
      bookingId: string;
      entryType: string;
      method: string;
      amount: { toString(): string };
    },
    bookingId: string,
    input: RecordPaymentInput,
    currency: string,
  ): boolean {
    return (
      existing.bookingId === bookingId &&
      existing.entryType === 'RECEIPT' &&
      existing.method === input.method &&
      money(existing.amount.toString()).eq(money(clientMoney(input.amount, currency, 'amount')))
    );
  }

  /** Records a RECEIPT. A retry with the same `Idempotency-Key` returns the first result (`replay: true`). */
  async record(
    bookingId: string,
    input: RecordPaymentInput,
    key: string,
  ): Promise<{ payment: PaymentDto; replay: boolean }> {
    try {
      return await this.recordOnce(bookingId, input, key);
    } catch (error) {
      // Two identical requests at the same moment: the loser of the unique key replays the winner.
      if (isUniqueViolation(error)) {
        const replay = await this.replayRecord(bookingId, input, key);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async replayRecord(bookingId: string, input: RecordPaymentInput, key: string) {
    return this.tenantDb.tx(async (tx) => {
      const existing = await tx.payment.findFirst({
        where: { tenantId: this.caller.tenantId, idempotencyKey: key },
        include: PAYMENT_INCLUDE,
      });
      if (!existing) return null;
      const b = await this.loadBooking(tx, existing.bookingId);
      if (!this.sameReceipt(existing, bookingId, input, b.currency))
        throw new IdempotencyConflictError();
      return { payment: paymentDto(existing, b.currency), replay: true };
    });
  }

  private async recordOnce(bookingId: string, input: RecordPaymentInput, key: string) {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadBooking(tx, bookingId);
      const existing = await tx.payment.findFirst({
        where: { tenantId, idempotencyKey: key },
        include: PAYMENT_INCLUDE,
      });
      if (existing) {
        if (!this.sameReceipt(existing, bookingId, input, b.currency))
          throw new IdempotencyConflictError();
        return { payment: paymentDto(existing, b.currency), replay: true };
      }
      if (!(PAYABLE_STATUSES as readonly string[]).includes(b.status)) {
        throw new InvalidStateTransitionError(
          'Payments are recorded while the slot is held or the booking is confirmed.',
        );
      }
      const amount = clientMoney(input.amount, b.currency, 'amount');
      if (!money(amount).gt(0))
        throw new FieldValidationError('amount', 'The amount must be above zero');
      const now = new Date();
      const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
      if (receivedAt.getTime() > now.getTime() + 5 * 60_000)
        throw new FieldValidationError('receivedAt', 'A payment cannot be dated in the future');

      const tenant = await loadTenantContext(tx, tenantId);
      const cheque = input.method === 'CHEQUE';
      const receiptNo = await nextNumber(tx, tenant, 'receipt');
      const created = await tx.payment.create({
        data: {
          tenantId,
          bookingId,
          entryType: 'RECEIPT',
          method: input.method,
          amount,
          status: cheque ? 'PENDING' : 'CLEARED',
          clearedAt: cheque ? null : receivedAt,
          reference: input.reference ?? null,
          receiptNo,
          receivedAt,
          receivedById: this.caller.userId,
          notes: input.notes ?? null,
          idempotencyKey: key,
        },
      });
      const paidTotal = await this.ledger.refreshPaidTotal(tx, tenantId, bookingId, b.currency);
      await this.audit.record(tx, {
        action: 'payment.record',
        entityType: 'payment',
        entityId: created.id,
        venueId: b.venueId,
        after: {
          receiptNo,
          method: input.method,
          amount,
          status: created.status,
          reference: input.reference,
          bookingNumber: b.number,
          paidTotal,
        },
      });
      await this.queueReceiptPdf(tx, tenantId, created.id, 'first');
      const row = await tx.payment.findFirstOrThrow({
        where: { id: created.id },
        include: PAYMENT_INCLUDE,
      });
      return { payment: paymentDto(row, b.currency), replay: false };
    });
  }

  private async queueReceiptPdf(tx: DbTx, tenantId: string, paymentId: string, stage: string) {
    await this.jobQueue.send(
      tx,
      JOB_NAMES.PDF_RENDER,
      { tenantId, kind: 'receipt', entityId: paymentId },
      { singletonKey: `receipt:${paymentId}:${stage}` },
    );
  }

  // ───────────────────────────── cheques ─────────────────────────────

  /** A cheque cleared: PENDING -> CLEARED. It counts from now on; a refund cheque completes its request. */
  async clear(id: string): Promise<PaymentDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const p = await this.loadPayment(tx, id);
      if (p.method !== 'CHEQUE' || p.entryType === 'REVERSAL' || p.status !== 'PENDING') {
        throw new InvalidStateTransitionError('Only a pending cheque can be cleared.');
      }
      const clearedAt = new Date();
      const updated = await tx.payment.updateMany({
        where: { id, tenantId, status: 'PENDING' },
        data: { status: 'CLEARED', clearedAt },
      });
      if (updated.count !== 1)
        throw new InvalidStateTransitionError('Only a pending cheque can be cleared.');
      const paidTotal = await this.ledger.refreshPaidTotal(
        tx,
        tenantId,
        p.bookingId,
        p.booking.currency,
      );
      if (p.entryType === 'REFUND' && p.refundRequestId) {
        await tx.refundRequest.updateMany({
          where: { id: p.refundRequestId, tenantId, status: 'APPROVED' },
          data: { status: 'PAID' },
        });
      }
      await this.audit.record(tx, {
        action: 'payment.clear',
        entityType: 'payment',
        entityId: id,
        venueId: p.booking.venueId,
        before: { status: 'PENDING' },
        after: { status: 'CLEARED', receiptNo: p.receiptNo, paidTotal },
      });
      if (p.entryType === 'RECEIPT') await this.queueReceiptPdf(tx, tenantId, id, 'cleared');
      const row = await tx.payment.findFirstOrThrow({ where: { id }, include: PAYMENT_INCLUDE });
      return paymentDto(row, p.booking.currency);
    });
  }

  /**
   * A cheque came back: PENDING or CLEARED -> BOUNCED (a bank can return a cheque after it cleared). A bounced receipt stops
   * counting, which lowers `paid_total`. A reversed entry cannot bounce; a refund cheque is never bounced here.
   */
  async bounce(id: string, input: BouncePaymentInput): Promise<PaymentDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const p = await this.loadPayment(tx, id);
      if (p.method !== 'CHEQUE' || p.entryType !== 'RECEIPT' || p.status === 'BOUNCED') {
        throw new InvalidStateTransitionError('Only a received cheque can be marked as bounced.');
      }
      if (p.reversedBy) {
        throw new InvalidStateTransitionError('This entry was reversed; it cannot be bounced.');
      }
      const updated = await tx.payment.updateMany({
        where: { id, tenantId, status: p.status },
        data: { status: 'BOUNCED' },
      });
      if (updated.count !== 1)
        throw new InvalidStateTransitionError('Only a received cheque can be marked as bounced.');
      const paidTotal = await this.ledger.refreshPaidTotal(
        tx,
        tenantId,
        p.bookingId,
        p.booking.currency,
      );
      await this.audit.record(tx, {
        action: 'payment.bounce',
        entityType: 'payment',
        entityId: id,
        venueId: p.booking.venueId,
        before: { status: p.status },
        after: {
          status: 'BOUNCED',
          receiptNo: p.receiptNo,
          paidTotal,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
      const row = await tx.payment.findFirstOrThrow({ where: { id }, include: PAYMENT_INCLUDE });
      return paymentDto(row, p.booking.currency);
    });
  }

  // ───────────────────────────── reversal ─────────────────────────────

  /**
   * A wrong entry is taken back by a new REVERSAL row that points to it (reason required). The original is never changed and
   * can be reversed once. Only CLEARED receipts are reversed: a pending or bounced cheque has nothing to take back, and a
   * refund is paid out money that a reversal cannot return.
   */
  async reverse(
    id: string,
    input: ReversePaymentInput,
    key: string,
  ): Promise<{ payment: PaymentDto; replay: boolean }> {
    try {
      return await this.reverseOnce(id, input, key);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.tenantDb.tx(async (tx) => {
          const existing = await tx.payment.findFirst({
            where: { tenantId: this.caller.tenantId, idempotencyKey: key },
            include: { ...PAYMENT_INCLUDE, booking: { select: { currency: true } } },
          });
          if (!existing) return null;
          if (existing.reversesId !== id) throw new IdempotencyConflictError();
          return { payment: paymentDto(existing, existing.booking.currency), replay: true };
        });
        if (replay) return replay;
        throw new InvalidStateTransitionError('This entry was already reversed.');
      }
      throw error;
    }
  }

  private async reverseOnce(id: string, input: ReversePaymentInput, key: string) {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const p = await this.loadPayment(tx, id);
      const existing = await tx.payment.findFirst({
        where: { tenantId, idempotencyKey: key },
        include: PAYMENT_INCLUDE,
      });
      if (existing) {
        if (existing.reversesId !== id) throw new IdempotencyConflictError();
        return { payment: paymentDto(existing, p.booking.currency), replay: true };
      }
      if (p.entryType !== 'RECEIPT') {
        throw new InvalidStateTransitionError('Only a receipt can be reversed.');
      }
      if (p.status !== 'CLEARED') {
        throw new InvalidStateTransitionError(
          'Only a cleared receipt can be reversed. Clear or bounce a pending cheque instead.',
        );
      }
      if (p.reversedBy) throw new InvalidStateTransitionError('This entry was already reversed.');
      const now = new Date();
      const created = await tx.payment.create({
        data: {
          tenantId,
          bookingId: p.bookingId,
          entryType: 'REVERSAL',
          method: p.method,
          amount: p.amount.toString(),
          status: 'CLEARED',
          clearedAt: now,
          reference: p.receiptNo,
          receivedAt: now,
          receivedById: this.caller.userId,
          notes: input.reason,
          idempotencyKey: key,
          reversesId: p.id,
        },
      });
      const paidTotal = await this.ledger.refreshPaidTotal(
        tx,
        tenantId,
        p.bookingId,
        p.booking.currency,
      );
      await this.audit.record(tx, {
        action: 'payment.reverse',
        entityType: 'payment',
        entityId: created.id,
        venueId: p.booking.venueId,
        before: {
          reverses: p.id,
          receiptNo: p.receiptNo,
          amount: formatMoney(p.amount.toString(), p.booking.currency),
        },
        after: { reason: input.reason, paidTotal },
      });
      const row = await tx.payment.findFirstOrThrow({
        where: { id: created.id },
        include: PAYMENT_INCLUDE,
      });
      return { payment: paymentDto(row, p.booking.currency), replay: false };
    });
  }

  // ───────────────────────────── the receipt ─────────────────────────────

  /** A pre-signed link to the receipt PDF (5 minutes). 422 while it is still being made. */
  async receiptLink(id: string): Promise<ReceiptLinkDto> {
    const tenantId = this.caller.tenantId;
    const p = await this.tenantDb.tx((tx) => this.loadPayment(tx, id));
    if (p.entryType !== 'RECEIPT' || !p.receiptNo) throw new NotFoundError();
    const file = await this.tenantDb.tx((tx) =>
      tx.receiptFile.findFirst({ where: { paymentId: id, tenantId } }),
    );
    if (!file) {
      throw new InvalidStateTransitionError(
        'The receipt is still being prepared. Try again in a moment.',
      );
    }
    if (file.pdfKey !== pdfObjectKey(tenantId, 'receipt', id)) throw new NotFoundError();
    const url = await this.presign.downloadUrl(tenantId, file.pdfKey, `${p.receiptNo}.pdf`);
    return { url, expiresInSeconds: 300 };
  }

  /** Sends the receipt to the customer (or to `to`) again, with the PDF attached. */
  async resendReceipt(id: string, input: ResendReceiptInput): Promise<{ to: string }> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const p = await this.loadPayment(tx, id);
      if (p.entryType !== 'RECEIPT' || !p.receiptNo) throw new NotFoundError();
      if (p.status !== 'CLEARED') {
        throw new InvalidStateTransitionError('A receipt is sent once the payment has cleared.');
      }
      const to = input.to ?? p.booking.customer.email;
      if (!to) {
        throw new InvalidStateTransitionError(
          'The customer has no email address. Give one to send to.',
        );
      }
      const file = await tx.receiptFile.findFirst({ where: { paymentId: id, tenantId } });
      if (!file) {
        throw new InvalidStateTransitionError(
          'The receipt is still being prepared. Try again in a moment.',
        );
      }
      const tenant = await loadTenantContext(tx, tenantId);
      const zone = p.booking.venue.timezone ?? tenant.timezone;
      await this.emailOutbox.enqueue(tx, {
        to,
        template: 'receipt.sent',
        locale: p.booking.customer.preferredLocale ?? tenant.defaultLocale,
        event: 'receipt.resent',
        entityType: 'payment',
        entityId: id,
        attachments: [{ key: file.pdfKey, filename: `${p.receiptNo}.pdf` }],
        vars: {
          customerName: p.booking.customer.name,
          tenantName: tenant.name,
          receiptNo: p.receiptNo,
          amount: `${p.booking.currency} ${formatMoney(p.amount.toString(), p.booking.currency)}`,
          method: METHOD_LABEL[p.method] ?? p.method,
          receivedOn: localDateOf(p.receivedAt, zone),
          bookingNumber: p.booking.number ?? '',
        },
      });
      await this.audit.record(tx, {
        action: 'payment.receipt_resend',
        entityType: 'payment',
        entityId: id,
        venueId: p.booking.venueId,
        after: { receiptNo: p.receiptNo, sent: true },
      });
      return { to };
    });
  }
}
