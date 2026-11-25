import { z } from 'zod';
import { LeadSourceSchema, LeadStageSchema } from '../lead-stages.js';
import {
  CreateCustomerSchema,
  CustomFieldValuesInputSchema,
  CustomFieldValuesSchema,
} from './customers.js';
import { Id, IsoDateTime, OptionalText, Rev, hasChange, listOf } from './common.js';
import { MoneyStringSchema } from './setup.js';

// Module 5, leads / inquiries (docs/01 module 5, docs/05 section 12). A lead is one inquiry of a customer for one venue.
// Stages: NEW -> CONTACTED -> SITE_VISIT -> QUOTED -> NEGOTIATION -> WON / LOST. LOST needs a reason, an open lead needs
// a next follow-up. WON and QUOTED are set by the booking and quotation modules once they exist; until then by hand.

export const LEAD_PAGE_SIZE_DEFAULT = 25;
export const LEAD_PAGE_SIZE_MAX = 100;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** An instant with an offset (`2027-02-14T09:00:00Z`, `...+05:00`). */
const Instant = z.iso.datetime({ offset: true });
const Guests = z.number().int().min(1).max(100000);
const Notes = OptionalText(4000);
const LostReason = z.string().trim().min(1).max(500);

export const LeadCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
});
export type LeadCustomerDto = z.infer<typeof LeadCustomerSchema>;

export const LeadAssigneeSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  name: z.string(),
});
export type LeadAssigneeDto = z.infer<typeof LeadAssigneeSchema>;

export const LeadSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  venueName: z.string(),
  customer: LeadCustomerSchema,
  eventTypeId: z.string().nullable(),
  eventTypeName: z.string().nullable(),
  preferredDate: DateOnly.nullable(),
  flexibleDates: z.boolean(),
  guests: z.number().int().nullable(),
  /** In the workspace currency, with its decimals. */
  budget: z.string().nullable(),
  source: LeadSourceSchema,
  stage: LeadStageSchema,
  lostReason: z.string().nullable(),
  assignee: LeadAssigneeSchema.nullable(),
  /** Required while the lead is open; `null` once it is won or lost. */
  nextFollowUpAt: IsoDateTime.nullable(),
  notes: z.string().nullable(),
  customFields: CustomFieldValuesSchema,
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LeadDto = z.infer<typeof LeadSchema>;

export const LeadListResponseSchema = z.object({
  data: z.array(LeadSchema),
  nextCursor: z.string().nullable(),
});
export type LeadListResponse = z.infer<typeof LeadListResponseSchema>;

/**
 * GET /v1/leads, newest first. `followUp=overdue`: open leads whose follow-up time has passed; `today`: open leads whose
 * follow-up falls on today's date in the workspace time zone (earlier or later). `search` matches the customer's name and
 * phone. A caller limited to some venues only sees those; `venueId` only narrows.
 */
export const LeadListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LEAD_PAGE_SIZE_MAX).default(LEAD_PAGE_SIZE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
  venueId: Id.optional(),
  stage: LeadStageSchema.optional(),
  /** A membership id (`GET /v1/leads/assignees`). */
  assigneeId: Id.optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  source: LeadSourceSchema.optional(),
  customerId: Id.optional(),
  followUp: z.enum(['overdue', 'today']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;

/** GET /v1/leads/follow-ups: the dashboard card. `mine`: only leads assigned to the caller. */
export const LeadFollowUpsQuerySchema = z.object({
  assignee: z.enum(['me', 'any']).default('me'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type LeadFollowUpsQuery = z.infer<typeof LeadFollowUpsQuerySchema>;

export const LeadFollowUpsSchema = z.object({
  /** Open leads whose follow-up time has passed. */
  overdue: z.number().int(),
  /** Open leads whose follow-up is still to come today (workspace time zone). */
  dueToday: z.number().int(),
  /** Overdue and due-today leads, the oldest follow-up first, up to `limit`. */
  items: z.array(LeadSchema),
});
export type LeadFollowUpsDto = z.infer<typeof LeadFollowUpsSchema>;

/** A member who may be given a lead: active, holds `lead.manage` and covers the venue. */
export const LeadAssigneeOptionSchema = LeadAssigneeSchema.extend({ roleName: z.string() });
export type LeadAssigneeOptionDto = z.infer<typeof LeadAssigneeOptionSchema>;
export const LeadAssigneeListResponseSchema = listOf(LeadAssigneeOptionSchema);
export type LeadAssigneeListResponse = z.infer<typeof LeadAssigneeListResponseSchema>;
export const LeadAssigneesQuerySchema = z.object({ venueId: Id.optional() });
export type LeadAssigneesQuery = z.infer<typeof LeadAssigneesQuerySchema>;

/** POST /v1/leads: an existing customer (`customerId`) or a new one made inline (`customer`), exactly one of them. */
export const CreateLeadSchema = z
  .object({
    venueId: Id,
    customerId: Id.optional(),
    customer: CreateCustomerSchema.optional(),
    eventTypeId: Id.nullable().optional(),
    preferredDate: DateOnly.nullable().optional(),
    flexibleDates: z.boolean().default(false),
    guests: Guests.nullable().optional(),
    budget: MoneyStringSchema.nullable().optional(),
    source: LeadSourceSchema,
    /** A membership id. Omitted: the caller. `null`: nobody. */
    assigneeId: Id.nullable().optional(),
    nextFollowUpAt: Instant,
    notes: Notes.optional(),
    customFields: CustomFieldValuesInputSchema.optional(),
  })
  .refine((v) => (v.customerId === undefined) !== (v.customer === undefined), {
    message: 'Give either customerId or customer',
    path: ['customerId'],
  });
export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

/**
 * PATCH /v1/leads/{id}. A lead keeps its customer. `stage` moves it (`LOST` needs `lostReason`; an open stage needs a
 * `nextFollowUpAt`, which closing a lead clears). Custom fields: only the keys sent change.
 */
export const UpdateLeadSchema = z
  .object({
    rev: Rev,
    venueId: Id.optional(),
    eventTypeId: Id.nullable().optional(),
    preferredDate: DateOnly.nullable().optional(),
    flexibleDates: z.boolean().optional(),
    guests: Guests.nullable().optional(),
    budget: MoneyStringSchema.nullable().optional(),
    source: LeadSourceSchema.optional(),
    assigneeId: Id.nullable().optional(),
    nextFollowUpAt: Instant.nullable().optional(),
    notes: Notes.optional(),
    customFields: CustomFieldValuesInputSchema.optional(),
    stage: LeadStageSchema.optional(),
    lostReason: LostReason.nullable().optional(),
  })
  .refine(hasChange, { message: 'Nothing to change' });
export type UpdateLeadInput = z.infer<typeof UpdateLeadSchema>;

/** One thing that changed in an activity entry. Values are shown as text (`NEW`, a date, a name). */
export const LeadActivityChangeSchema = z.object({
  field: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type LeadActivityChangeDto = z.infer<typeof LeadActivityChangeSchema>;

export const LEAD_ACTIVITY_ACTIONS = [
  'lead.create',
  'lead.update',
  'lead.stage_change',
  'lead.assign',
] as const;
export type LeadActivityAction = (typeof LEAD_ACTIVITY_ACTIONS)[number];

/** The activity log of a lead, read from the audit rows (stage changes, notes and other edits, assignment). */
export const LeadActivitySchema = z.object({
  id: z.string(),
  action: z.enum(LEAD_ACTIVITY_ACTIONS),
  createdAt: IsoDateTime,
  /** `null` for the system. */
  actorName: z.string().nullable(),
  changes: z.array(LeadActivityChangeSchema),
});
export type LeadActivityDto = z.infer<typeof LeadActivitySchema>;
export const LeadActivityListResponseSchema = listOf(LeadActivitySchema);
export type LeadActivityListResponse = z.infer<typeof LeadActivityListResponseSchema>;
