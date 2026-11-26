import { z } from 'zod';
import { BookingStatusSchema } from '../booking-states.js';
import { Id, IsoDateTime, Rev, hasChange } from './common.js';
import { LocalTimeSchema, MoneyStringSchema } from './setup.js';

// Modules 6-8: availability calendar, quotations and bookings (docs/01, docs/05 sections 2-4, 6, 13). Prices are strings with
// the workspace currency's decimals, or `null` for a caller without `booking.view_prices`. The client never sends a price:
// it names catalogue ids and quantities, the server prices them.

/** `YYYY-MM-DD` and a real calendar day (not 2031-02-30). */
const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a real date');
const Guests = z.number().int().min(1).max(100000);
const Notes = z.string().trim().max(2000);

// ───────────────────────────── what a quote is built from ─────────────────────────────

export const AddOnSelectionSchema = z.object({
  addOnId: Id,
  /** PER_UNIT add-ons are billed per unit; for the other pricings it is a multiplier of 1 (ignored). */
  quantity: z.number().int().min(1).max(1000).default(1),
});
export type AddOnSelection = z.infer<typeof AddOnSelectionSchema>;

/**
 * One session (function: Mehndi, Barat, Walima ...) of a quotation. FIXED and FULL_DAY slots take their times from the slot
 * template; an HOURLY slot also needs `startTime` and `endTime` (venue-local, inside the slot's window).
 */
export const SessionInputSchema = z.object({
  /** Existing session when a DRAFT's sessions are replaced; omitted for a new one. */
  id: Id.optional(),
  spaceId: Id,
  date: DateOnly,
  slotId: Id,
  startTime: LocalTimeSchema.optional(),
  endTime: LocalTimeSchema.optional(),
  eventTypeId: Id.nullable().optional(),
  packageId: Id.nullable().optional(),
  guests: Guests,
  /** Billed at least this many guests whatever the actual number (docs/05 section 3). */
  guaranteedGuests: Guests.nullable().optional(),
  addOns: z
    .array(AddOnSelectionSchema)
    .max(30)
    .refine((a) => new Set(a.map((x) => x.addOnId)).size === a.length, 'Each add-on once')
    .default([]),
  setupNotes: Notes.nullable().optional(),
  kitchenNotes: Notes.nullable().optional(),
});
export type SessionInput = z.infer<typeof SessionInputSchema>;

/** Discount on the booking subtotal: a percentage, or an amount in the workspace currency (docs/05 section 3 step 5). */
export const DiscountInputSchema = z.object({
  type: z.enum(['PERCENT', 'AMOUNT']),
  value: MoneyStringSchema,
});
export type DiscountInput = z.infer<typeof DiscountInputSchema>;

/** Re-quote at the rates frozen in the booking (default for a held booking) or at the current catalogue and rules. */
export const RequoteSchema = z.enum(['FROZEN', 'CURRENT']);
export type Requote = z.infer<typeof RequoteSchema>;

/** POST /v1/quotations/preview and POST /v1/quotations. A customer (or a lead, which has one) is needed to SAVE it. */
export const QuoteInputSchema = z.object({
  venueId: Id,
  customerId: Id.optional(),
  leadId: Id.optional(),
  sessions: z.array(SessionInputSchema).min(1).max(10),
  discount: DiscountInputSchema.nullable().optional(),
  cancellationPolicyId: Id.nullable().optional(),
  notes: Notes.nullable().optional(),
});
export type QuoteInput = z.infer<typeof QuoteInputSchema>;

export const CreateQuotationSchema = QuoteInputSchema.refine(
  (v) => v.customerId !== undefined || v.leadId !== undefined,
  { message: 'Give a customer or a lead', path: ['customerId'] },
);
export type CreateQuotationInput = z.infer<typeof CreateQuotationSchema>;

// ───────────────────────────── what a quote looks like ─────────────────────────────

export const LINE_ITEM_KINDS = [
  'RENT',
  'PACKAGE',
  'ADD_ON',
  'ADJUSTMENT',
  'DISCOUNT',
  'TAX',
] as const;
export const LineItemKindSchema = z.enum(LINE_ITEM_KINDS);

export const LineItemSchema = z.object({
  id: z.string().nullable(),
  /** Position of the session in `sessions`; `null` for the lines of the whole booking (discount, tax). */
  sessionIndex: z.number().int().nullable(),
  kind: LineItemKindSchema,
  description: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  quantity: z.string(),
  /** Signed like `amount`. `null` without `booking.view_prices`. */
  unitPrice: z.string().nullable(),
  /** Signed (DISCOUNT <= 0, ADJUSTMENT +/-, others >= 0); the grand total is the sum. With inclusive tax: net of tax. */
  amount: z.string().nullable(),
  /** The tax contained in this line with inclusive tax (else "0"). */
  taxAmount: z.string().nullable(),
  /** What the customer sees: `amount + taxAmount` (the same as `amount` with exclusive tax). */
  grossAmount: z.string().nullable(),
});
export type LineItemDto = z.infer<typeof LineItemSchema>;

export const QuoteTotalsSchema = z.object({
  subtotal: z.string().nullable(),
  discountTotal: z.string().nullable(),
  taxTotal: z.string().nullable(),
  grandTotal: z.string().nullable(),
});
export type QuoteTotalsDto = z.infer<typeof QuoteTotalsSchema>;

export const TaxRateSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  ratePct: z.string(),
  inclusive: z.boolean(),
});
export type TaxRateSnapshotDto = z.infer<typeof TaxRateSnapshotSchema>;

export const SESSION_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export const SessionSchema = z.object({
  id: z.string().nullable(),
  index: z.number().int(),
  status: z.enum(SESSION_STATUSES),
  spaceId: z.string(),
  spaceName: z.string(),
  date: DateOnly,
  slotId: z.string(),
  slotName: z.string(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  hours: z.string(),
  eventTypeId: z.string().nullable(),
  eventTypeName: z.string().nullable(),
  packageId: z.string().nullable(),
  packageName: z.string().nullable(),
  guests: z.number().int(),
  guaranteedGuests: z.number().int().nullable(),
  /** `max(guests, package minimum, guaranteed)`: what per-head lines are billed on. */
  billedGuests: z.number().int(),
  addOns: z.array(z.object({ addOnId: z.string(), name: z.string(), quantity: z.number().int() })),
  setupNotes: z.string().nullable(),
  kitchenNotes: z.string().nullable(),
  /** Sum of the session's own lines; `null` without `booking.view_prices`. */
  subtotal: z.string().nullable(),
});
export type SessionDto = z.infer<typeof SessionSchema>;

export const WARNING_CODES = ['SLOT_TAKEN', 'LOCAL_RULE'] as const;
export const QuoteWarningSchema = z.object({
  code: z.enum(WARNING_CODES),
  sessionIndex: z.number().int(),
  /** `SLOT_TAKEN`: the booking number that holds it, when the caller may see it. */
  detail: z.string().nullable(),
});
export type QuoteWarningDto = z.infer<typeof QuoteWarningSchema>;

export const QuotePreviewSchema = z.object({
  currency: z.string(),
  sessions: z.array(SessionSchema),
  lines: z.array(LineItemSchema),
  totals: QuoteTotalsSchema,
  taxRate: TaxRateSnapshotSchema.nullable(),
  discount: z.object({ type: z.enum(['PERCENT', 'AMOUNT']), value: z.string() }).nullable(),
  /** The role's limit, so the form can say what it may give. */
  maxDiscountPct: z.number(),
  /** Slots that are already taken and venue rules that are broken: a warning, not an error. */
  warnings: z.array(QuoteWarningSchema),
});
export type QuotePreviewDto = z.infer<typeof QuotePreviewSchema>;

// ───────────────────────────── bookings ─────────────────────────────

export const BookingSummarySchema = z.object({
  id: z.string(),
  /** Assigned when the booking is first held; `null` for a draft quotation. */
  number: z.string().nullable(),
  status: BookingStatusSchema,
  venueId: z.string(),
  venueName: z.string(),
  customer: z.object({ id: z.string(), name: z.string(), phone: z.string() }),
  leadId: z.string().nullable(),
  /** Start of the first active session. */
  firstSessionAt: IsoDateTime.nullable(),
  sessionCount: z.number().int(),
  quoteVersion: z.number().int(),
  holdExpiresAt: IsoDateTime.nullable(),
  grandTotal: z.string().nullable(),
  paidTotal: z.string().nullable(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
});
export type BookingSummaryDto = z.infer<typeof BookingSummarySchema>;

export const BookingListResponseSchema = z.object({
  data: z.array(BookingSummarySchema),
  nextCursor: z.string().nullable(),
});
export type BookingListResponse = z.infer<typeof BookingListResponseSchema>;

export const BOOKING_PAGE_SIZE_MAX = 100;
/** GET /v1/bookings. `from` / `to`: the date of the first session (workspace time zone, inclusive). */
export const BookingListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BOOKING_PAGE_SIZE_MAX).default(25),
  cursor: z.string().min(1).max(200).optional(),
  status: BookingStatusSchema.optional(),
  venueId: Id.optional(),
  customerId: Id.optional(),
  leadId: Id.optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export type BookingListQuery = z.infer<typeof BookingListQuerySchema>;

export const QuotationVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  number: z.string(),
  grandTotal: z.string().nullable(),
  validUntil: DateOnly.nullable(),
  sentAt: IsoDateTime.nullable(),
  acceptedAt: IsoDateTime.nullable(),
  /** The PDF has been rendered and can be downloaded or attached. */
  pdfReady: z.boolean(),
  createdAt: IsoDateTime,
});
export type QuotationVersionDto = z.infer<typeof QuotationVersionSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  at: IsoDateTime,
  actorName: z.string().nullable(),
  /** The reason given (cancellation, override), when the entry has one. */
  reason: z.string().nullable(),
});
export type TimelineEntryDto = z.infer<typeof TimelineEntrySchema>;

export const CancellationSnapshotSchema = z.object({
  policyId: z.string().nullable(),
  name: z.string(),
  tiers: z.array(z.object({ minDaysBefore: z.number().int(), refundPct: z.number() })),
});
export type CancellationSnapshotDto = z.infer<typeof CancellationSnapshotSchema>;

export const BookingDetailSchema = BookingSummarySchema.extend({
  currency: z.string(),
  sessions: z.array(SessionSchema),
  lines: z.array(LineItemSchema),
  totals: QuoteTotalsSchema,
  taxRate: TaxRateSnapshotSchema.nullable(),
  discount: z.object({ type: z.enum(['PERCENT', 'AMOUNT']), value: z.string() }).nullable(),
  warnings: z.array(QuoteWarningSchema),
  notes: z.string().nullable(),
  holdExtensions: z.number().int(),
  confirmedAt: IsoDateTime.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  cancelReason: z.string().nullable(),
  suggestedRefund: z.string().nullable(),
  cancellationPolicy: CancellationSnapshotSchema.nullable(),
  quotations: z.array(QuotationVersionSchema),
  timeline: z.array(TimelineEntrySchema),
});
export type BookingDetailDto = z.infer<typeof BookingDetailSchema>;

/** PATCH /v1/bookings/{id}. `sessions` replaces the sessions of a DRAFT; held bookings use the per-session endpoints. */
export const UpdateBookingSchema = z
  .object({
    rev: Rev,
    notes: Notes.nullable().optional(),
    discount: DiscountInputSchema.nullable().optional(),
    cancellationPolicyId: Id.nullable().optional(),
    sessions: z.array(SessionInputSchema).min(1).max(10).optional(),
    requote: RequoteSchema.optional(),
  })
  .refine(hasChange, { message: 'Nothing to change' });
export type UpdateBookingInput = z.infer<typeof UpdateBookingSchema>;

/** The extra a local rule breach needs: the permission `booking.override_rules` and a reason (audited). */
export const HoldBookingSchema = z.object({
  rev: Rev,
  overrideRules: z.boolean().default(false),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type HoldBookingInput = z.infer<typeof HoldBookingSchema>;

export const RevOnlySchema = z.object({ rev: Rev });
export type RevOnlyInput = z.infer<typeof RevOnlySchema>;

export const ConfirmBookingSchema = z.object({
  rev: Rev,
  /** Confirm without the required advance (`booking.confirm_override`); a reason is required. */
  override: z.boolean().default(false),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingSchema>;

export const CancelBookingSchema = z.object({
  rev: Rev,
  reason: z.string().trim().min(3).max(500),
});
export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

export const AddSessionSchema = z.object({
  rev: Rev,
  session: SessionInputSchema,
  requote: RequoteSchema.optional(),
  overrideRules: z.boolean().default(false),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type AddSessionInput = z.infer<typeof AddSessionSchema>;

export const UpdateSessionSchema = z
  .object({
    rev: Rev,
    spaceId: Id.optional(),
    date: DateOnly.optional(),
    slotId: Id.optional(),
    startTime: LocalTimeSchema.optional(),
    endTime: LocalTimeSchema.optional(),
    eventTypeId: Id.nullable().optional(),
    packageId: Id.nullable().optional(),
    guests: Guests.optional(),
    guaranteedGuests: Guests.nullable().optional(),
    addOns: z.array(AddOnSelectionSchema).max(30).optional(),
    setupNotes: Notes.nullable().optional(),
    kitchenNotes: Notes.nullable().optional(),
    requote: RequoteSchema.optional(),
    overrideRules: z.boolean().default(false),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine(
    (v) =>
      Object.keys(v).some(
        (k) =>
          !['rev', 'requote', 'overrideRules', 'reason'].includes(k) &&
          v[k as keyof typeof v] !== undefined,
      ),
    { message: 'Nothing to change' },
  );
export type UpdateSessionInput = z.infer<typeof UpdateSessionSchema>;

export const CancelSessionSchema = z.object({
  rev: Rev,
  reason: z.string().trim().min(3).max(500).optional(),
});
export type CancelSessionInput = z.infer<typeof CancelSessionSchema>;

export const BookingSessionParamSchema = z.object({ id: Id, sessionId: Id });

/** The answer of cancelling: the booking and what the policy says could be refunded (module 9 executes refunds). */
export const CancelResultSchema = BookingDetailSchema.extend({
  refund: z
    .object({
      daysBefore: z.number().int(),
      refundPct: z.number(),
      /** Cleared receipts the suggestion is based on. */
      received: z.string().nullable(),
      suggested: z.string().nullable(),
    })
    .nullable(),
});
export type CancelResultDto = z.infer<typeof CancelResultSchema>;

// ───────────────────────────── availability (module 6) ─────────────────────────────

export const AVAILABILITY_MAX_DAYS = 62;
export const AvailabilityQuerySchema = z
  .object({ venueId: Id, from: DateOnly, to: DateOnly })
  .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['to'] });
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export const CELL_STATUSES = ['HELD', 'CONFIRMED'] as const;
export const AvailabilityEntrySchema = z.object({
  bookingId: z.string(),
  number: z.string().nullable(),
  status: z.enum(CELL_STATUSES),
  customerName: z.string(),
  sessionId: z.string(),
  eventTypeName: z.string().nullable(),
  holdExpiresAt: IsoDateTime.nullable(),
  /** Which physical space of a combined space is taken (the space itself for a plain space). */
  blockedBy: z.string().nullable(),
});

export const AvailabilityCellSchema = z.object({
  spaceId: z.string(),
  date: DateOnly,
  slotId: z.string(),
  /** Only taken cells are listed; every other cell of the grid is free. */
  status: z.enum(CELL_STATUSES),
  entries: z.array(AvailabilityEntrySchema),
});
export type AvailabilityCellDto = z.infer<typeof AvailabilityCellSchema>;

export const AvailabilitySchema = z.object({
  venueId: z.string(),
  from: DateOnly,
  to: DateOnly,
  timezone: z.string(),
  spaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isCombined: z.boolean(),
      capacitySeated: z.number().int().nullable(),
      componentIds: z.array(z.string()),
    }),
  ),
  slots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mode: z.enum(['FIXED', 'HOURLY', 'FULL_DAY']),
      startTime: z.string(),
      endTime: z.string(),
      /** Weekdays it is offered on (0 = Sunday); empty = every day. */
      daysOfWeek: z.array(z.number().int()),
    }),
  ),
  cells: z.array(AvailabilityCellSchema),
});
export type AvailabilityDto = z.infer<typeof AvailabilitySchema>;
