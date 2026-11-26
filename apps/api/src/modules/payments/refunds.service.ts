import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import { formatMoney, money } from '@venueos/shared';
import type {
  CreateRefundRequestInput,
  DecideRefundInput,
  PayRefundInput,
  RefundRequestDto,
  RefundRequestListQuery,
  RefundRequestListResponse,
  RejectRefundInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/db-errors';
import {
  FieldValidationError,
  ForbiddenError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { clientMoney } from '../../common/money/tenant-money';
import { PaymentsLedger } from './core/ledger.service';
import { REFUND_INCLUDE, refundDto } from './core/views';

const encodeCursor = (id: string): string => Buffer.from(`r1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('r1:') || decoded.length < 4)
    throw new FieldValidationError('cursor', 'Invalid cursor');
  return decoded.slice(3);
}

/**
 * Refunds (docs/05 sections 5 and 6): a request (`payment.refund.request`), a decision by someone else
 * (`payment.refund.approve`; the one person of a workspace who may approve can approve their own, audited), and "mark paid"
 * (`payment.record`), which writes the REFUND payment: CLEARED at once, or PENDING for a cheque until it clears. The two-person
 * rule is also a database CHECK. Creating a request or the payment needs an `Idempotency-Key`.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly audit: AuditService,
    private readonly ledger: PaymentsLedger,
  ) {}

  private scope(): Prisma.BookingWhereInput {
    const ids = this.venueScope.filterIds();
    return ids ? { venueId: { in: ids } } : {};
  }

  private async loadRequest(tx: DbTx, id: string) {
    const row = await tx.refundRequest.findFirst({
      where: { id, tenantId: this.caller.tenantId, booking: this.scope() },
      include: {
        ...REFUND_INCLUDE,
        booking: { select: { ...REFUND_INCLUDE.booking.select, venueId: true } },
      },
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  async list(query: RefundRequestListQuery): Promise<RefundRequestListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const rows = await tx.refundRequest.findMany({
        where: {
          tenantId,
          booking: this.scope(),
          ...(query.status ? { status: query.status } : {}),
          ...(query.bookingId ? { bookingId: query.bookingId } : {}),
        },
        include: REFUND_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => refundDto(r)),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  /** What a new request may ask for: the cleared net, less what is already requested or approved and not yet paid out. */
  private async refundable(tx: DbTx, tenantId: string, bookingId: string): Promise<string> {
    const net = await this.ledger.net(tx, tenantId, bookingId);
    const open = await tx.refundRequest.findMany({
      where: { tenantId, bookingId, status: { in: ['REQUESTED', 'APPROVED'] } },
      select: { amount: true },
    });
    return open.reduce((sum, r) => sum.minus(r.amount.toString()), money(net)).toString();
  }

  // ───────────────────────────── request ─────────────────────────────

  async create(
    bookingId: string,
    input: CreateRefundRequestInput,
    key: string,
  ): Promise<{ request: RefundRequestDto; replay: boolean }> {
    try {
      return await this.createOnce(bookingId, input, key);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.tenantDb.tx(async (tx) => {
          const existing = await tx.refundRequest.findFirst({
            where: { tenantId: this.caller.tenantId, idempotencyKey: key },
            include: REFUND_INCLUDE,
          });
          if (!existing) return null;
          if (existing.bookingId !== bookingId) throw new IdempotencyConflictError();
          return { request: refundDto(existing), replay: true };
        });
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async createOnce(bookingId: string, input: CreateRefundRequestInput, key: string) {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: bookingId, tenantId, ...this.scope() },
        select: { id: true, venueId: true, status: true, currency: true, number: true },
      });
      if (!b) throw new NotFoundError();
      const amount = clientMoney(input.amount, b.currency, 'amount');
      const existing = await tx.refundRequest.findFirst({
        where: { tenantId, idempotencyKey: key },
        include: REFUND_INCLUDE,
      });
      if (existing) {
        if (existing.bookingId !== bookingId || !money(existing.amount.toString()).eq(amount))
          throw new IdempotencyConflictError();
        return { request: refundDto(existing), replay: true };
      }
      if (b.status === 'DRAFT') {
        throw new InvalidStateTransitionError('A quotation has no payments to refund.');
      }
      if (!money(amount).gt(0))
        throw new FieldValidationError('amount', 'The amount must be above zero');
      const refundable = await this.refundable(tx, tenantId, bookingId);
      if (money(amount).gt(refundable)) {
        throw new InvalidStateTransitionError(
          `A refund cannot be more than what was paid and is not yet being refunded (${formatMoney(
            money(refundable).gt(0) ? refundable : '0',
            b.currency,
          )}).`,
        );
      }
      const created = await tx.refundRequest.create({
        data: {
          tenantId,
          bookingId,
          amount,
          reason: input.reason,
          requestedById: this.caller.userId,
          idempotencyKey: key,
        },
        include: REFUND_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'refund.request',
        entityType: 'refund_request',
        entityId: created.id,
        venueId: b.venueId,
        after: { amount, reason: input.reason, bookingNumber: b.number },
      });
      return { request: refundDto(created), replay: false };
    });
  }

  // ───────────────────────────── decision ─────────────────────────────

  /**
   * Who may decide: someone other than the requester, or the requester when they are the ONLY active member of the
   * workspace who may approve refunds (then it is recorded as `self_approved`).
   */
  private async decider(
    tx: DbTx,
    requestedById: string,
  ): Promise<{ userId: string; self: boolean }> {
    const userId = this.caller.userId;
    if (userId !== requestedById) return { userId, self: false };
    const approvers = await tx.membership.count({
      where: {
        tenantId: this.caller.tenantId,
        active: true,
        role: { permissions: { has: 'payment.refund.approve' } },
      },
    });
    if (approvers !== 1) {
      throw new ForbiddenError(
        'Another person has to decide a refund you requested. Only a workspace with a single approver may approve its own.',
      );
    }
    return { userId, self: true };
  }

  async approve(id: string, input: DecideRefundInput): Promise<RefundRequestDto> {
    return this.decide(id, input.rev, 'APPROVED', input.note);
  }

  async reject(id: string, input: RejectRefundInput): Promise<RefundRequestDto> {
    return this.decide(id, input.rev, 'REJECTED', input.note);
  }

  private async decide(
    id: string,
    rev: number,
    to: 'APPROVED' | 'REJECTED',
    note: string | undefined,
  ): Promise<RefundRequestDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const r = await this.loadRequest(tx, id);
      if (r.rev !== rev) throw new VersionConflictError();
      if (r.status !== 'REQUESTED') {
        throw new InvalidStateTransitionError('This refund request has already been decided.');
      }
      const who = await this.decider(tx, r.requestedById);
      const updated = await tx.refundRequest.updateMany({
        where: { id, tenantId, rev, status: 'REQUESTED' },
        data: {
          status: to,
          approvedById: who.userId,
          selfApproved: who.self,
          decidedAt: new Date(),
          decisionNote: note ?? null,
        },
      });
      if (updated.count !== 1) throw new VersionConflictError();
      await this.audit.record(tx, {
        action: to === 'APPROVED' ? 'refund.approve' : 'refund.reject',
        entityType: 'refund_request',
        entityId: id,
        venueId: r.booking.venueId,
        before: { status: 'REQUESTED' },
        after: {
          status: to,
          amount: formatMoney(r.amount.toString(), r.booking.currency),
          selfApproved: who.self,
          ...(note ? { note } : {}),
        },
      });
      return refundDto(await this.loadRequest(tx, id));
    });
  }

  // ───────────────────────────── pay out ─────────────────────────────

  async pay(
    id: string,
    input: PayRefundInput,
    key: string,
  ): Promise<{ request: RefundRequestDto; replay: boolean }> {
    try {
      return await this.payOnce(id, input, key);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.tenantDb.tx(async (tx) => {
          const existing = await tx.payment.findFirst({
            where: { tenantId: this.caller.tenantId, idempotencyKey: key },
            select: { refundRequestId: true },
          });
          if (!existing) return null;
          if (existing.refundRequestId !== id) throw new IdempotencyConflictError();
          return { request: refundDto(await this.loadRequest(tx, id)), replay: true };
        });
        if (replay) return replay;
        throw new InvalidStateTransitionError('This refund has already been paid.');
      }
      throw error;
    }
  }

  private async payOnce(id: string, input: PayRefundInput, key: string) {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const r = await this.loadRequest(tx, id);
      const existing = await tx.payment.findFirst({
        where: { tenantId, idempotencyKey: key },
        select: { refundRequestId: true },
      });
      if (existing) {
        if (existing.refundRequestId !== id) throw new IdempotencyConflictError();
        return { request: refundDto(r), replay: true };
      }
      if (r.rev !== input.rev) throw new VersionConflictError();
      if (r.status !== 'APPROVED' || r.payment) {
        throw new InvalidStateTransitionError(
          'Only an approved refund that is not paid yet can be paid.',
        );
      }
      // Cheque refunds that have not cleared are money already promised: they come off what can still be paid.
      const net = await this.ledger.net(tx, tenantId, r.bookingId);
      const pendingOut = await tx.payment.findMany({
        where: { tenantId, bookingId: r.bookingId, entryType: 'REFUND', status: 'PENDING' },
        select: { amount: true },
      });
      const available = pendingOut.reduce((s, p) => s.minus(p.amount.toString()), money(net));
      if (money(r.amount.toString()).gt(available)) {
        throw new InvalidStateTransitionError(
          'More than what the customer has paid and has not had refunded yet cannot be paid out.',
        );
      }
      const cheque = input.method === 'CHEQUE';
      const now = new Date();
      await tx.payment.create({
        data: {
          tenantId,
          bookingId: r.bookingId,
          entryType: 'REFUND',
          method: input.method,
          amount: r.amount.toString(),
          status: cheque ? 'PENDING' : 'CLEARED',
          clearedAt: cheque ? null : now,
          reference: input.reference ?? null,
          receivedAt: now,
          receivedById: this.caller.userId,
          notes: input.notes ?? null,
          idempotencyKey: key,
          refundRequestId: id,
        },
      });
      if (!cheque) {
        const done = await tx.refundRequest.updateMany({
          where: { id, tenantId, rev: input.rev, status: 'APPROVED' },
          data: { status: 'PAID' },
        });
        if (done.count !== 1) throw new VersionConflictError();
      }
      const paidTotal = await this.ledger.refreshPaidTotal(
        tx,
        tenantId,
        r.bookingId,
        r.booking.currency,
      );
      await this.audit.record(tx, {
        action: 'refund.pay',
        entityType: 'refund_request',
        entityId: id,
        venueId: r.booking.venueId,
        before: { status: 'APPROVED' },
        after: {
          status: cheque ? 'APPROVED' : 'PAID',
          method: input.method,
          amount: formatMoney(r.amount.toString(), r.booking.currency),
          reference: input.reference,
          paidTotal,
        },
      });
      return { request: refundDto(await this.loadRequest(tx, id)), replay: false };
    });
  }
}
