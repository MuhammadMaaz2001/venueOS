import { z } from 'zod';
import { LeadStageSchema } from '../lead-stages.js';
import { EmailSchema } from './auth.js';
import { Id, IncludeInactive, IsoDateTime, Name, OptionalText, Rev, hasChange } from './common.js';

// Module 4, customers (docs/01 module 4, docs/05 section 12, docs/04 section 6). A customer is a person or family that
// asks for or books an event. Phone is NOT unique (relatives share numbers): the API reports possible duplicates and the
// screen warns, it never blocks.

export const CUSTOMER_PAGE_SIZE_DEFAULT = 25;
export const CUSTOMER_PAGE_SIZE_MAX = 100;

/** A tenant-defined field value as sent by a client: text, a number, or `null` to clear it. */
export const CustomFieldValueInputSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.null(),
]);
const FieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Invalid field key');

/**
 * Values of custom fields by field key (`custom_field_defs.key`). The server validates them against the definitions of
 * the record type (type, choices, required) and answers 400 naming the key. On a PATCH only the keys that are sent
 * change; `null` clears one.
 */
export const CustomFieldValuesInputSchema = z
  .record(FieldKeySchema, CustomFieldValueInputSchema)
  .refine((v) => Object.keys(v).length <= 50, 'At most 50 fields');
export type CustomFieldValuesInput = z.infer<typeof CustomFieldValuesInputSchema>;

/** What a read returns for a custom field: the value, or the MASKED value of a sensitive field. */
export const CustomFieldValueSchema = z.union([z.string(), z.number(), z.null()]);
export const CustomFieldValuesSchema = z.record(z.string(), CustomFieldValueSchema);
export type CustomFieldValues = z.infer<typeof CustomFieldValuesSchema>;

/** A phone as typed (`0300 1234567`, `+92 300 1234567`); the server stores E.164 using the workspace country. */
export const PhoneInputSchema = z.string().trim().min(3).max(32);
const Locale = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as "en"')
  .max(35);

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** E.164 (`+923001234567`). */
  phone: z.string(),
  altPhone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  /** `null` = the workspace's default language. */
  preferredLocale: z.string().nullable(),
  notes: z.string().nullable(),
  /** By field key. A sensitive field holds its MASKED value (`*****-*****67-1`), see `sensitiveKeys`. */
  customFields: CustomFieldValuesSchema,
  /** Keys of `customFields` whose value is masked; `POST /v1/customers/{id}/reveal/{key}` shows the clear value. */
  sensitiveKeys: z.array(z.string()),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CustomerDto = z.infer<typeof CustomerSchema>;

/** Another customer with the same phone or email as the one being saved. */
export const CustomerDuplicateSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  matchedOn: z.array(z.enum(['phone', 'email'])).min(1),
});
export type CustomerDuplicateDto = z.infer<typeof CustomerDuplicateSchema>;

/** A lead of the customer, as the customer page lists it (the full lead is `GET /v1/leads/{id}`). */
export const CustomerLeadSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  venueName: z.string(),
  eventTypeName: z.string().nullable(),
  stage: LeadStageSchema,
  preferredDate: z.string().nullable(),
  nextFollowUpAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type CustomerLeadDto = z.infer<typeof CustomerLeadSchema>;

/**
 * One customer with what belongs to the detail page: their leads (only those of the caller's venues, and only with
 * `lead.view`; bookings arrive with module 8) and the possible duplicates (same phone or email).
 */
export const CustomerDetailSchema = CustomerSchema.extend({
  leads: z.array(CustomerLeadSchema),
  duplicates: z.array(CustomerDuplicateSchema),
});
export type CustomerDetailDto = z.infer<typeof CustomerDetailSchema>;

export const CustomerListResponseSchema = z.object({
  data: z.array(CustomerSchema),
  nextCursor: z.string().nullable(),
});
export type CustomerListResponse = z.infer<typeof CustomerListResponseSchema>;

/** GET /v1/customers: `search` matches name, phone and email (contains, any case). */
export const CustomerListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CUSTOMER_PAGE_SIZE_MAX)
    .default(CUSTOMER_PAGE_SIZE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  includeInactive: IncludeInactive,
});
export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;

/** GET /v1/customers/duplicates: the check the form runs while typing. At least one of `phone`, `email`. */
export const CustomerDuplicatesQuerySchema = z
  .object({
    phone: PhoneInputSchema.optional(),
    email: z.string().trim().max(254).optional(),
    /** The customer being edited, so it does not match itself. */
    excludeId: Id.optional(),
  })
  .refine((v) => v.phone !== undefined || (v.email !== undefined && v.email !== ''), {
    message: 'Give a phone or an email',
  });
export type CustomerDuplicatesQuery = z.infer<typeof CustomerDuplicatesQuerySchema>;

export const CustomerDuplicatesResponseSchema = z.object({
  data: z.array(CustomerDuplicateSchema),
  nextCursor: z.null(),
});
export type CustomerDuplicatesResponse = z.infer<typeof CustomerDuplicatesResponseSchema>;

/** POST /v1/customers (also the inline customer of POST /v1/leads). */
export const CreateCustomerSchema = z.object({
  name: Name(150),
  phone: PhoneInputSchema,
  altPhone: PhoneInputSchema.nullable().optional(),
  email: EmailSchema.nullable().optional(),
  address: OptionalText(500).optional(),
  preferredLocale: Locale.nullable().optional(),
  notes: OptionalText(2000).optional(),
  customFields: CustomFieldValuesInputSchema.optional(),
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

/** PATCH /v1/customers/{id}. `active: false` is the soft delete. Custom fields: only the keys sent change. */
export const UpdateCustomerSchema = z
  .object({
    rev: Rev,
    name: Name(150).optional(),
    phone: PhoneInputSchema.optional(),
    altPhone: PhoneInputSchema.nullable().optional(),
    email: EmailSchema.nullable().optional(),
    address: OptionalText(500).optional(),
    preferredLocale: Locale.nullable().optional(),
    notes: OptionalText(2000).optional(),
    customFields: CustomFieldValuesInputSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, { message: 'Nothing to change' });
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export const CustomerRevealParamSchema = z.object({ id: Id, fieldKey: FieldKeySchema });
export type CustomerRevealParam = z.infer<typeof CustomerRevealParamSchema>;

/** POST /v1/customers/{id}/reveal/{fieldKey}: the clear value (numbers as text). Audited; needs `customer.view_sensitive`. */
export const RevealedValueSchema = z.object({ key: z.string(), value: z.string() });
export type RevealedValueDto = z.infer<typeof RevealedValueSchema>;
