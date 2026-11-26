import type { Prisma } from '@venueos/db';
import { formatMoney } from '@venueos/shared';
import type { PaymentDto, RefundRequestDto } from '@venueos/shared';

export const PAYMENT_INCLUDE = {
  receivedBy: { select: { name: true } },
  reversedBy: { select: { id: true } },
  receiptFile: { select: { id: true } },
} satisfies Prisma.PaymentInclude;
export type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

export function paymentDto(row: PaymentRow, currency: string): PaymentDto {
  return {
    id: row.id,
    bookingId: row.bookingId,
    entryType: row.entryType,
    method: row.method,
    amount: formatMoney(row.amount.toString(), currency),
    status: row.status,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    reference: row.reference,
    receiptNo: row.receiptNo,
    receivedAt: row.receivedAt.toISOString(),
    receivedByName: row.receivedBy?.name ?? null,
    notes: row.notes,
    reversesId: row.reversesId,
    reversedById: row.reversedBy?.id ?? null,
    refundRequestId: row.refundRequestId,
    receiptReady: row.receiptFile !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const REFUND_INCLUDE = {
  booking: { select: { number: true, currency: true, customer: { select: { name: true } } } },
  requestedBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  payment: { select: { id: true, status: true } },
} satisfies Prisma.RefundRequestInclude;
export type RefundRow = Prisma.RefundRequestGetPayload<{ include: typeof REFUND_INCLUDE }>;

export function refundDto(row: RefundRow): RefundRequestDto {
  return {
    id: row.id,
    bookingId: row.bookingId,
    bookingNumber: row.booking.number,
    customerName: row.booking.customer.name,
    status: row.status,
    amount: formatMoney(row.amount.toString(), row.booking.currency),
    reason: row.reason,
    requestedById: row.requestedById,
    requestedByName: row.requestedBy.name,
    approvedByName: row.approvedBy?.name ?? null,
    selfApproved: row.selfApproved,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    paymentId: row.payment?.id ?? null,
    paymentStatus: row.payment?.status ?? null,
    rev: row.rev,
    createdAt: row.createdAt.toISOString(),
  };
}
