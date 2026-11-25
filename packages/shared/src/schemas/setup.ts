import { z } from 'zod';
import { TenantSettings } from '../tenant-settings.js';
import { isTimeZone } from './auth.js';
import { Id, IncludeInactive, IsoDateTime, Name, OptionalText, Rev, listOf } from './common.js';

// Module 1, setup and onboarding (docs/01 module 1, docs/05 sections 1 and 15): tenant settings, venues,
// spaces (also combined ones), slot templates, per-space slot prices and event types.

/** Venue-local wall clock time, 24 h. */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24 h)');
/** A non-negative decimal string; its decimals are checked against the tenant currency in the service. */
export const MoneyStringSchema = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Use a non-negative decimal amount');
const TimeZoneSchema = z.string().max(64).refine(isTimeZone, 'Unknown IANA time zone');

export const IdParamSchema = z.object({ id: Id });

// ───────────────────────────── tenant settings ─────────────────────────────

export const TenantSettingsResponseSchema = z.object({
  name: z.string(),
  slug: z.string(),
  country: z.string(),
  /** Read-only: money is frozen against it. */
  currency: z.string(),
  timezone: z.string(),
  defaultLocale: z.string(),
  settings: TenantSettings,
  rev: z.number().int(),
});
export type TenantSettingsResponse = z.infer<typeof TenantSettingsResponseSchema>;

const settingsShape = TenantSettings.shape;
/** Every settings key optional and WITHOUT its default: a patch must never reset the keys it does not name. */
export const TenantSettingsPatchSchema = z.object({
  bookingPrefix: settingsShape.bookingPrefix.removeDefault().optional(),
  holdHours: settingsShape.holdHours.removeDefault().optional(),
  advancePct: settingsShape.advancePct.removeDefault().optional(),
  tokenAmount: settingsShape.tokenAmount.removeDefault().optional(),
  balanceDueDays: settingsShape.balanceDueDays.removeDefault().optional(),
  guestLockDays: settingsShape.guestLockDays.removeDefault().optional(),
  reminderDays: settingsShape.reminderDays.removeDefault().optional(),
  eventReminderDays: settingsShape.eventReminderDays.removeDefault().optional(),
  minHours: settingsShape.minHours.removeDefault().optional(),
});
export type TenantSettingsPatch = z.infer<typeof TenantSettingsPatchSchema>;

/** PATCH /v1/tenant/settings. Currency and country cannot change after signup. */
export const UpdateTenantSettingsSchema = z
  .object({
    rev: Rev,
    name: Name(100).optional(),
    timezone: TimeZoneSchema.optional(),
    settings: TenantSettingsPatchSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined || v.settings !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateTenantSettingsInput = z.infer<typeof UpdateTenantSettingsSchema>;

// ───────────────────────────── venues ─────────────────────────────

export const LocalRulesSchema = z.object({
  latestEndTime: LocalTimeSchema.optional(),
  maxGuests: z.number().int().min(1).max(100000).optional(),
});
export type LocalRules = z.infer<typeof LocalRulesSchema>;

export const VenueSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  /** IANA zone overriding the tenant's; null = the tenant's. */
  timezone: z.string().nullable(),
  /** Venue-local opening hours for HOURLY slots; both null = no restriction. */
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  localRules: LocalRulesSchema,
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VenueDto = z.infer<typeof VenueSchema>;
export const VenueListResponseSchema = listOf(VenueSchema);
export type VenueListResponse = z.infer<typeof VenueListResponseSchema>;

export const VenueListQuerySchema = z.object({ includeInactive: IncludeInactive });

const hoursBothOrNeither = (v: { opensAt?: string | null; closesAt?: string | null }) =>
  (v.opensAt === undefined || v.opensAt === null) ===
  (v.closesAt === undefined || v.closesAt === null);
const HOURS_MESSAGE = 'Set both opening and closing time, or neither';

const venueFields = {
  name: Name(100),
  address: OptionalText(200).optional(),
  city: OptionalText(80).optional(),
  timezone: TimeZoneSchema.nullable().optional(),
  opensAt: LocalTimeSchema.nullable().optional(),
  closesAt: LocalTimeSchema.nullable().optional(),
  localRules: LocalRulesSchema.optional(),
};

/** POST /v1/venues */
export const CreateVenueSchema = z
  .object(venueFields)
  .refine(hoursBothOrNeither, { message: HOURS_MESSAGE, path: ['closesAt'] });
export type CreateVenueInput = z.infer<typeof CreateVenueSchema>;

/** PATCH /v1/venues/{id}: `rev` is the concurrency token; `active: false` is the soft delete. */
export const UpdateVenueSchema = z
  .object({
    rev: Rev,
    name: venueFields.name.optional(),
    address: venueFields.address,
    city: venueFields.city,
    timezone: venueFields.timezone,
    opensAt: venueFields.opensAt,
    closesAt: venueFields.closesAt,
    localRules: venueFields.localRules,
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'rev' && v[k as keyof typeof v] !== undefined), {
    message: 'Nothing to change',
  })
  .refine(
    // Only checked when the patch names both times: a half-patch is completed against the stored venue in the service.
    (v) => v.opensAt === undefined || v.closesAt === undefined || hoursBothOrNeither(v),
    { message: HOURS_MESSAGE, path: ['closesAt'] },
  );
export type UpdateVenueInput = z.infer<typeof UpdateVenueSchema>;

// ───────────────────────────── spaces ─────────────────────────────

export const SPACE_KINDS = [
  'HALL',
  'LAWN',
  'MARQUEE',
  'ROOFTOP',
  'ROOM',
  'FARMHOUSE',
  'OTHER',
] as const;
export const SpaceKindSchema = z.enum(SPACE_KINDS);
export type SpaceKind = z.infer<typeof SpaceKindSchema>;

export const SpaceSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  name: z.string(),
  kind: SpaceKindSchema,
  capacitySeated: z.number().int().nullable(),
  capacityStanding: z.number().int().nullable(),
  minGuests: z.number().int().nullable(),
  isCombined: z.boolean(),
  /** Physical spaces a combined space is made of (empty for a physical space). */
  componentIds: z.array(z.string()),
  setupBufferMin: z.number().int(),
  cleanupBufferMin: z.number().int(),
  /** Default rent per slot, in the tenant currency; null = priced per slot only. */
  baseRent: z.string().nullable(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpaceDto = z.infer<typeof SpaceSchema>;
export const SpaceListResponseSchema = listOf(SpaceSchema);
export type SpaceListResponse = z.infer<typeof SpaceListResponseSchema>;

export const SpaceListQuerySchema = z.object({
  venueId: Id.optional(),
  includeInactive: IncludeInactive,
});

const Guests = z.number().int().min(1).max(100000).nullable();
const BufferMin = z.number().int().min(0).max(1440);
const ComponentIds = z.array(Id).min(2).max(20);

/**
 * POST /v1/spaces. A combined space (Hall A+B) lists the physical spaces it is made of; a physical one
 * lists none. Whether the components exist, share the venue and are physical is checked in the service.
 */
export const CreateSpaceSchema = z
  .object({
    venueId: Id,
    name: Name(100),
    kind: SpaceKindSchema.default('HALL'),
    capacitySeated: Guests.optional(),
    capacityStanding: Guests.optional(),
    minGuests: Guests.optional(),
    isCombined: z.boolean().default(false),
    componentIds: ComponentIds.optional(),
    setupBufferMin: BufferMin.default(0),
    cleanupBufferMin: BufferMin.default(0),
    baseRent: MoneyStringSchema.nullable().optional(),
  })
  .refine((v) => v.isCombined === (v.componentIds !== undefined), {
    message: 'A combined space needs its components; a physical space has none',
    path: ['componentIds'],
  })
  .refine((v) => new Set(v.componentIds ?? []).size === (v.componentIds ?? []).length, {
    message: 'Each component once',
    path: ['componentIds'],
  });
export type CreateSpaceInput = z.infer<typeof CreateSpaceSchema>;

/** PATCH /v1/spaces/{id}. Venue and the combined flag are fixed at creation. `active: false` is the soft delete. */
export const UpdateSpaceSchema = z
  .object({
    rev: Rev,
    name: Name(100).optional(),
    kind: SpaceKindSchema.optional(),
    capacitySeated: Guests.optional(),
    capacityStanding: Guests.optional(),
    minGuests: Guests.optional(),
    componentIds: ComponentIds.optional(),
    setupBufferMin: BufferMin.optional(),
    cleanupBufferMin: BufferMin.optional(),
    baseRent: MoneyStringSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'rev' && v[k as keyof typeof v] !== undefined), {
    message: 'Nothing to change',
  })
  .refine((v) => new Set(v.componentIds ?? []).size === (v.componentIds ?? []).length, {
    message: 'Each component once',
    path: ['componentIds'],
  });
export type UpdateSpaceInput = z.infer<typeof UpdateSpaceSchema>;

// ───────────────────────────── slot templates ─────────────────────────────

export const SLOT_MODES = ['FIXED', 'HOURLY', 'FULL_DAY'] as const;
export const SlotModeSchema = z.enum(SLOT_MODES);
export type SlotMode = z.infer<typeof SlotModeSchema>;

/** FULL_DAY has no clock times of its own: it is stored as this pair, read as "the whole day" (docs/05 section 1). */
export const FULL_DAY_START = '00:00';
export const FULL_DAY_END = '00:00';

export const SlotTemplateSchema = z.object({
  id: z.string(),
  venueId: z.string(),
  name: z.string(),
  mode: SlotModeSchema,
  /** Venue-local; an end earlier than (or, for FULL_DAY, equal to) the start ends the next day. */
  startTime: z.string(),
  endTime: z.string(),
  /** 0 = Sunday .. 6 = Saturday; empty = every day. */
  daysOfWeek: z.array(z.number().int()),
  /** HOURLY only; null = the tenant's `minHours`. */
  minHours: z.number().int().nullable(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SlotTemplateDto = z.infer<typeof SlotTemplateSchema>;
export const SlotTemplateListResponseSchema = listOf(SlotTemplateSchema);
export type SlotTemplateListResponse = z.infer<typeof SlotTemplateListResponseSchema>;

export const SlotTemplateListQuerySchema = z.object({
  venueId: Id.optional(),
  includeInactive: IncludeInactive,
});

const DaysOfWeek = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'Each day once');
const MinHours = z.number().int().min(1).max(24);

/**
 * POST /v1/slot-templates.
 *  - FIXED: a named shift, `startTime` and `endTime` required and different.
 *  - HOURLY: the window defaults to the venue's opening hours; `minHours` is optional.
 *  - FULL_DAY: no times (the server stores the whole day).
 */
export const CreateSlotTemplateSchema = z
  .object({
    venueId: Id,
    name: Name(60),
    mode: SlotModeSchema,
    startTime: LocalTimeSchema.optional(),
    endTime: LocalTimeSchema.optional(),
    daysOfWeek: DaysOfWeek.default([]),
    minHours: MinHours.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'FIXED') {
      if (v.startTime === undefined) {
        ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Required for a fixed slot' });
      }
      if (v.endTime === undefined) {
        ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Required for a fixed slot' });
      }
      if (v.startTime !== undefined && v.startTime === v.endTime) {
        ctx.addIssue({
          code: 'custom',
          path: ['endTime'],
          message: 'Start and end must differ',
        });
      }
    }
    if (v.mode !== 'HOURLY' && v.minHours !== undefined && v.minHours !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['minHours'],
        message: 'Only hourly slots have a minimum',
      });
    }
    if (v.mode === 'FULL_DAY' && (v.startTime !== undefined || v.endTime !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: 'A full-day slot has no times',
      });
    }
  });
export type CreateSlotTemplateInput = z.infer<typeof CreateSlotTemplateSchema>;

/** PATCH /v1/slot-templates/{id}. Venue and mode are fixed at creation. `active: false` is the soft delete. */
export const UpdateSlotTemplateSchema = z
  .object({
    rev: Rev,
    name: Name(60).optional(),
    startTime: LocalTimeSchema.optional(),
    endTime: LocalTimeSchema.optional(),
    daysOfWeek: DaysOfWeek.optional(),
    minHours: MinHours.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'rev' && v[k as keyof typeof v] !== undefined), {
    message: 'Nothing to change',
  });
export type UpdateSlotTemplateInput = z.infer<typeof UpdateSlotTemplateSchema>;

// ───────────────────────────── space slot prices ─────────────────────────────

export const SpaceSlotPriceSchema = z.object({
  slotId: z.string(),
  /** Rent per slot (FIXED, FULL_DAY) or per hour (HOURLY), in the tenant currency. */
  rent: z.string(),
});
export type SpaceSlotPriceDto = z.infer<typeof SpaceSlotPriceSchema>;
export const SpaceSlotPricesResponseSchema = z.object({ data: z.array(SpaceSlotPriceSchema) });
export type SpaceSlotPricesResponse = z.infer<typeof SpaceSlotPricesResponseSchema>;

/**
 * PUT /v1/spaces/{id}/slot-prices replaces the whole price list of the space: a slot that is not listed has
 * no own price (the booking falls back to the space's `baseRent`).
 */
export const ReplaceSpaceSlotPricesSchema = z.object({
  prices: z
    .array(z.object({ slotId: Id, rent: MoneyStringSchema }))
    .max(100)
    .refine((p) => new Set(p.map((x) => x.slotId)).size === p.length, 'Each slot once'),
});
export type ReplaceSpaceSlotPricesInput = z.infer<typeof ReplaceSpaceSlotPricesSchema>;

// ───────────────────────────── event types ─────────────────────────────

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');

export const EventTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EventTypeDto = z.infer<typeof EventTypeSchema>;
export const EventTypeListResponseSchema = listOf(EventTypeSchema);
export type EventTypeListResponse = z.infer<typeof EventTypeListResponseSchema>;

export const EventTypeListQuerySchema = z.object({ includeInactive: IncludeInactive });

/** POST /v1/event-types */
export const CreateEventTypeSchema = z.object({
  name: Name(60),
  color: Color.nullable().optional(),
});
export type CreateEventTypeInput = z.infer<typeof CreateEventTypeSchema>;

/** PATCH /v1/event-types/{id}. `active: false` is the soft delete. */
export const UpdateEventTypeSchema = z
  .object({
    rev: Rev,
    name: Name(60).optional(),
    color: Color.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'rev' && v[k as keyof typeof v] !== undefined), {
    message: 'Nothing to change',
  });
export type UpdateEventTypeInput = z.infer<typeof UpdateEventTypeSchema>;
