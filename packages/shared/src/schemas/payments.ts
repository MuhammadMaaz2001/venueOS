import { z } from 'zod';
import { BookingStatusSchema } from '../booking-states.js';
import { Id, IsoDateTime, Rev } from './common.js';
import { MoneyStringSchema } from './setup.js';

// Module 9: payments, the payment schedule, receipts, refunds and receivables (docs/05 sections 5-6, docs/04 section 7).
// Amounts are strings with the workspace currency's decimals. A payment's amount is always positive: `entryType` decides the
// effect (RECEIPT +, REFUND -, REVERSAL negates the entry it points to).

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a real date');
const Reason = z.string().trim().min(3).max(500);
const Notes = z.string().trim().max(1000);

/** The `Idempotency-Key` header of every request that creates a payment or a refund request (docs/04 section 7). */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,100}$/, 'Use 8-100 letters, digits or _ . : -');

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'CARD',
  'MOBILE_WALLET',
  'ONLINE_GATEWAY',
] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
/** What staff can enter by hand (the gateway is reserved for Phase 2). */
export const MANUAL_PAYMENT_METHODS = PAYMENT_METHODS.filter((m) => m !== 'ONLINE_GATEWAY');

export const PAYMENT_STATUSES = ['PENDING', 'CLEARED', 'BOUNCED'] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const PAYMENT_ENTRY_TYPES = ['RECEIPT', 'REFUND', 'REVERSAL'] as const;
export const PaymentEntryTypeSchema = z.enum(PAYMENT_ENTRY_TYPES);

// ───────────────────────────── payments ─────────────────────────────

/** POST /v1/bookings/{id}/payments. A cheque starts PENDING and needs its number as `reference`. */
export const RecordPaymentSchema = z
  .object({
    method: PaymentMethodSchema.exclude(['ONLINE_GATEWAY']),
    amount: MoneyStringSchema,
    reference: z.string().trim().min(1).max(100).optional(),
    /** When the money arrived, if not now (cannot be in the future). */
    receivedAt: IsoDateTime.optional(),
    notes: Notes.optional(),
  })
  .refine((v) => v.method !== 'CHEQUE' || (v.reference !== undefined && v.reference !== ''), {
    message: 'A cheque needs its number',
    path: ['reference'],
  });
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export const PaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  entryType: PaymentEntryTypeSchema,
  method: PaymentMethodSchema,
  amount: z.string(),
  status: PaymentStatusSchema,
  clearedAt: IsoDateTime.nullable(),
  reference: z.string().nullable(),
  /** `{prefix}-R-{year}-{seq:5}`; receipts only. */
  receiptNo: z.string().nullable(),
  receivedAt: IsoDateTime,
  receivedByName: z.string().nullable(),
  /** The reason of a reversal, or the note of an entry. */
  notes: z.string().nullable(),
  /** A REVERSAL points to the entry it negates. */
  reversesId: z.string().nullable(),
  /** The REVERSAL that negated this entry, if any (an entry is reversed once). */
  reversedById: z.string().nullable(),
  refundRequestId: z.string().nullable(),
  /** The receipt PDF has been made. */
  receiptReady: z.boolean(),
  createdAt: IsoDateTime,
});
export type PaymentDto = z.infer<typeof PaymentSchema>;

export const ReversePaymentSchema = z.object({ reason: Reason });
export type ReversePaymentInput = z.infer<typeof ReversePaymentSchema>;

/** POST /v1/payments/{id}/bounce: a returned cheque; the reason is kept on the entry. */
export const BouncePaymentSchema = z.object({ reason: Reason.optional() });
export type BouncePaymentInput = z.infer<typeof BouncePaymentSchema>;

export const ResendReceiptSchema = z.object({ to: z.email().max(254).optional() });
export type ResendReceiptInput = z.infer<typeof ResendReceiptSchema>;
export const ResendReceiptResultSchema = z.object({ to: z.string() });
export const ReceiptLinkSchema = z.object({ url: z.string(), expiresInSeconds: z.number().int() });
export type ReceiptLinkDto = z.infer<typeof ReceiptLinkSchema>;

// ───────────────────────────── schedule ─────────────────────────────

export const SCHEDULE_STATUSES = ['PAID', 'PARTLY', 'UNPAID', 'OVERDUE'] as const;
export const ScheduleStatusSchema = z.enum(SCHEDULE_STATUSES);

export const ScheduleItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  dueDate: DateOnly,
  amount: z.string(),
  /** What the FIFO allocation of the cleared receipts gives this item. */
  allocated: z.string(),
  remaining: z.string(),
  status: ScheduleStatusSchema,
  /** The payment-due reminder was sent. */
  reminded: z.boolean(),
});
export type ScheduleItemDto = z.infer<typeof ScheduleItemSchema>;

/** PUT /v1/bookings/{id}/payment-schedule: the whole schedule; the amounts must add up to the grand total. */
export const ReplaceScheduleSchema = z.object({
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        dueDate: DateOnly,
        amount: MoneyStringSchema,
      }),
    )
    .min(1)
    .max(12),
});
export type ReplaceScheduleInput = z.infer<typeof ReplaceScheduleSchema>;

// ───────────────────────────── refunds ─────────────────────────────

export const REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PAID'] as const;
export const RefundStatusSchema = z.enum(REFUND_STATUSES);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

/** POST /v1/bookings/{id}/refund-requests. */
export const CreateRefundRequestSchema = z.object({ amount: MoneyStringSchema, reason: Reason });
export type CreateRefundRequestInput = z.infer<typeof CreateRefundRequestSchema>;

export const DecideRefundSchema = z.object({ rev: Rev, note: Notes.optional() });
export type DecideRefundInput = z.infer<typeof DecideRefundSchema>;
export const RejectRefundSchema = z.object({ rev: Rev, note: Reason });
export type RejectRefundInput = z.infer<typeof RejectRefundSchema>;

/** POST /v1/refund-requests/{id}/pay: the money goes out; this writes the REFUND payment. */
export const PayRefundSchema = z
  .object({
    rev: Rev,
    method: PaymentMethodSchema.exclude(['ONLINE_GATEWAY']),
    reference: z.string().trim().min(1).max(100).optional(),
    notes: Notes.optional(),
  })
  .refine((v) => v.method !== 'CHEQUE' || (v.reference !== undefined && v.reference !== ''), {
    message: 'A cheque needs its number',
    path: ['reference'],
  });
export type PayRefundInput = z.infer<typeof PayRefundSchema>;

export const RefundRequestSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  bookingNumber: z.string().nullable(),
  customerName: z.string(),
  status: RefundStatusSchema,
  amount: z.string(),
  reason: z.string(),
  requestedById: z.string(),
  requestedByName: z.string(),
  approvedByName: z.string().nullable(),
  /** The requester approved it themselves (a workspace with one person who may approve). */
  selfApproved: z.boolean(),
  decidedAt: IsoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  /** The REFUND payment, once the money has been paid out. */
  paymentId: z.string().nullable(),
  paymentStatus: PaymentStatusSchema.nullable(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
});
export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

export const RefundRequestListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
  status: RefundStatusSchema.optional(),
  bookingId: Id.optional(),
});
export type RefundRequestListQuery = z.infer<typeof RefundRequestListQuerySchema>;
export const RefundRequestListResponseSchema = z.object({
  data: z.array(RefundRequestSchema),
  nextCursor: z.string().nullable(),
});
export type RefundRequestListResponse = z.infer<typeof RefundRequestListResponseSchema>;

// ───────────────────────────── the Payments tab of a booking ─────────────────────────────

export const PaymentSummarySchema = z.object({
  grandTotal: z.string(),
  /** Cleared net receipts: CLEARED receipts less CLEARED refunds, reversals applied. */
  paidTotal: z.string(),
  /** Cheques received that have not cleared yet (they do not count). */
  pendingCheques: z.string(),
  /** Received beyond the grand total: shown as credit, settled by a refund. */
  credit: z.string(),
  balanceDue: z.string(),
  advancePct: z.number(),
  advanceRequired: z.string(),
  advanceMet: z.boolean(),
  /** The hold is open and the advance is in: confirming is one click (nothing confirms by itself). */
  readyToConfirm: z.boolean(),
  /** From the cancellation policy snapshot, once the booking is cancelled. */
  suggestedRefund: z.string().nullable(),
  /** The most a new refund request may ask for (paid, less what is already requested or paid out). */
  refundable: z.string(),
});
export type PaymentSummaryDto = z.infer<typeof PaymentSummarySchema>;

export const PaymentsOverviewSchema = z.object({
  bookingId: z.string(),
  bookingNumber: z.string().nullable(),
  bookingStatus: BookingStatusSchema,
  currency: z.string(),
  summary: PaymentSummarySchema,
  schedule: z.array(ScheduleItemSchema),
  payments: z.array(PaymentSchema),
  refundRequests: z.array(RefundRequestSchema),
});
export type PaymentsOverviewDto = z.infer<typeof PaymentsOverviewSchema>;

// ───────────────────────────── receivables ─────────────────────────────

export const ReceivableSchema = z.object({
  bookingId: z.string(),
  number: z.string().nullable(),
  status: BookingStatusSchema,
  venueId: z.string(),
  venueName: z.string(),
  customer: z.object({ id: z.string(), name: z.string(), phone: z.string() }),
  firstSessionAt: IsoDateTime.nullable(),
  grandTotal: z.string(),
  paidTotal: z.string(),
  balanceDue: z.string(),
  /** The first schedule item still owed. */
  nextDueDate: DateOnly.nullable(),
  nextDueAmount: z.string().nullable(),
  /** What is owed on items already past due, and since how many days (the oldest one). */
  overdueAmount: z.string(),
  overdueDays: z.number().int().nullable(),
});
export type ReceivableDto = z.infer<typeof ReceivableSchema>;

export const ReceivablesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
  venueId: Id.optional(),
  /** Next due date from / to (workspace time zone, inclusive). */
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  overdue: z.enum(['true', 'false']).optional(),
});
export type ReceivablesQuery = z.infer<typeof ReceivablesQuerySchema>;
export const ReceivablesResponseSchema = z.object({
  currency: z.string(),
  data: z.array(ReceivableSchema),
  nextCursor: z.string().nullable(),
});
export type ReceivablesResponse = z.infer<typeof ReceivablesResponseSchema>;

const CountAmount = z.object({ count: z.number().int(), amount: z.string() });
export const ReceivablesSummarySchema = z.object({
  currency: z.string(),
  /** Unpaid schedule items due in the next 7 days (today included), not yet overdue. */
  dueThisWeek: CountAmount,
  overdue: CountAmount,
  outstanding: CountAmount,
});
export type ReceivablesSummaryDto = z.infer<typeof ReceivablesSummarySchema>;
