import { z } from 'zod';
import { BookingStatusSchema } from '../booking-states.js';
import { Id, IsoDateTime } from './common.js';
import { QuotePreviewSchema, QuotationVersionSchema } from './bookings.js';

// Module 7, quotations: each priced version of a booking is a `quotations` row (docs/05 sections 3 and 13).

/** One version of a quotation with its frozen lines (what the customer was shown). */
export const QuotationSchema = QuotePreviewSchema.omit({
  warnings: true,
  maxDiscountPct: true,
}).extend({
  id: z.string(),
  bookingId: z.string(),
  bookingStatus: BookingStatusSchema,
  bookingNumber: z.string().nullable(),
  number: z.string(),
  version: z.number().int(),
  /** The newest version of the booking (an older one is history). */
  isLatest: z.boolean(),
  customer: z.object({
    id: z.string(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
  }),
  venueName: z.string(),
  validUntil: z.string().nullable(),
  sentAt: IsoDateTime.nullable(),
  acceptedAt: IsoDateTime.nullable(),
  pdfReady: z.boolean(),
  createdAt: IsoDateTime,
  rev: z.number().int(),
});
export type QuotationDto = z.infer<typeof QuotationSchema>;

export const QuotationListItemSchema = QuotationVersionSchema.extend({
  bookingId: z.string(),
  bookingStatus: BookingStatusSchema,
  customerName: z.string(),
  isLatest: z.boolean(),
});
export type QuotationListItemDto = z.infer<typeof QuotationListItemSchema>;

export const QuotationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
  bookingId: Id.optional(),
  customerId: Id.optional(),
  leadId: Id.optional(),
});
export type QuotationListQuery = z.infer<typeof QuotationListQuerySchema>;

export const QuotationListResponseSchema = z.object({
  data: z.array(QuotationListItemSchema),
  nextCursor: z.string().nullable(),
});
export type QuotationListResponse = z.infer<typeof QuotationListResponseSchema>;

/** POST /v1/quotations/{id}/send: to the customer's email address, or to `to` (e.g. a relative who decides). */
export const SendQuotationSchema = z.object({
  to: z.email().max(254).optional(),
  message: z.string().trim().max(1000).optional(),
});
export type SendQuotationInput = z.infer<typeof SendQuotationSchema>;

export const SendQuotationResultSchema = z.object({ sentAt: IsoDateTime, to: z.string() });
export type SendQuotationResultDto = z.infer<typeof SendQuotationResultSchema>;

/** GET /v1/quotations/{id}/pdf: a pre-signed download link that works for a few minutes. */
export const QuotationPdfSchema = z.object({ url: z.string(), expiresInSeconds: z.number().int() });
export type QuotationPdfDto = z.infer<typeof QuotationPdfSchema>;

/** GET /v1/quotations/{id}/whatsapp: a `wa.me` link with a text summary. No file link: PDFs stay private. */
export const QuotationWhatsAppSchema = z.object({ url: z.string(), text: z.string() });
export type QuotationWhatsAppDto = z.infer<typeof QuotationWhatsAppSchema>;
