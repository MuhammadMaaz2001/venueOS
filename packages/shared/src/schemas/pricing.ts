import { z } from 'zod';
import { money } from '../money.js';
import { Id, IncludeInactive, IsoDateTime, Name, Rev, hasChange, listOf } from './common.js';

// Module 3, pricing (docs/01 module 3, docs/05 sections 3 and 6): price rules, tax rates, cancellation policies and
// the read-only rent preview. Money is a string with the tenant currency's decimals.

const NOTHING = { message: 'Nothing to change' } as const;

/** A calendar date `YYYY-MM-DD` that exists (no 2027-02-30), between the years 2000 and 2100. */
export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
export const DateOnlySchema = z.string().refine(isRealDate, 'Use a real date, YYYY-MM-DD');

/** A decimal that may be negative; its decimals are checked against the tenant currency (or 3 for a percentage). */
const SignedDecimalSchema = z.string().regex(/^-?\d{1,15}(\.\d{1,3})?$/, 'Use a decimal number');

// ───────────────────────────── price rules ─────────────────────────────

export const PRICE_RULE_KINDS = ['DAY_OF_WEEK', 'DATE_RANGE', 'SPECIFIC_DATE'] as const;
export const PriceRuleKindSchema = z.enum(PRICE_RULE_KINDS);
export type PriceRuleKind = z.infer<typeof PriceRuleKindSchema>;

export const ADJUSTMENT_KINDS = ['PERCENT', 'FIXED_AMOUNT', 'OVERRIDE'] as const;
export const AdjustmentKindSchema = z.enum(ADJUSTMENT_KINDS);
export type AdjustmentKind = z.infer<typeof AdjustmentKindSchema>;

const DaysOfWeek = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'Each day once');

export const PriceRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: PriceRuleKindSchema,
  /** null = every space. */
  spaceId: z.string().nullable(),
  /** null = every slot. */
  slotId: z.string().nullable(),
  /** The venue of the space or slot the rule is limited to; null = the whole workspace. */
  venueId: z.string().nullable(),
  /** DAY_OF_WEEK only: 0 = Sunday .. 6 = Saturday. */
  daysOfWeek: z.array(z.number().int()),
  /** DATE_RANGE: first day (inclusive). SPECIFIC_DATE: the day. */
  startDate: z.string().nullable(),
  /** DATE_RANGE: last day (inclusive). */
  endDate: z.string().nullable(),
  adjustment: AdjustmentKindSchema,
  /** PERCENT: +20 = 20% more, -10 = 10% less. FIXED_AMOUNT: signed amount. OVERRIDE: the new rent. */
  value: z.string(),
  /** Higher wins: an override is chosen by it, and percent / fixed rules apply highest first. */
  priority: z.number().int(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PriceRuleDto = z.infer<typeof PriceRuleSchema>;
export const PriceRuleListResponseSchema = listOf(PriceRuleSchema);
export type PriceRuleListResponse = z.infer<typeof PriceRuleListResponseSchema>;

export const PriceRuleListQuerySchema = z.object({
  includeInactive: IncludeInactive,
  spaceId: Id.optional(),
  slotId: Id.optional(),
});

/** What decides whether a rule is well formed, independent of ids (those are loaded in the service). */
export interface PriceRuleShape {
  kind: PriceRuleKind;
  daysOfWeek: readonly number[];
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  adjustment: AdjustmentKind;
  value: string;
}

export interface ShapeIssue {
  path: string;
  message: string;
}

/**
 * The rules of a price rule's shape (docs/05 section 3):
 *  - DAY_OF_WEEK: 1-7 weekdays, no dates.
 *  - DATE_RANGE: first and last day, last not before first, no weekdays.
 *  - SPECIFIC_DATE: that one day only.
 *  - PERCENT: -100..1000 and not 0. FIXED_AMOUNT: not 0, within +/- 1e12. OVERRIDE: 0 or more.
 */
export function priceRuleShapeIssues(rule: PriceRuleShape): ShapeIssue[] {
  const issues: ShapeIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const start = rule.startDate ?? null;
  const end = rule.endDate ?? null;

  if (rule.kind === 'DAY_OF_WEEK') {
    if (rule.daysOfWeek.length === 0) add('daysOfWeek', 'Choose at least one weekday');
    if (start !== null) add('startDate', 'A weekday rule has no dates');
    if (end !== null) add('endDate', 'A weekday rule has no dates');
  } else {
    if (rule.daysOfWeek.length > 0) add('daysOfWeek', 'Only a weekday rule has weekdays');
    if (start === null) add('startDate', 'Required');
    else if (!isRealDate(start)) add('startDate', 'Use a real date, YYYY-MM-DD');
    if (rule.kind === 'DATE_RANGE') {
      if (end === null) add('endDate', 'Required');
      else if (!isRealDate(end)) add('endDate', 'Use a real date, YYYY-MM-DD');
      else if (start !== null && isRealDate(start) && end < start) {
        add('endDate', 'The last day cannot be before the first day');
      }
    } else if (end !== null) {
      add('endDate', 'A single-date rule has no end date');
    }
  }

  let value: ReturnType<typeof money> | null = null;
  try {
    value = money(rule.value);
  } catch {
    add('value', 'Use a decimal number');
  }
  if (value !== null) {
    if (rule.adjustment === 'PERCENT') {
      if (value.isZero()) add('value', 'A 0% change does nothing');
      else if (value.lt(-100) || value.gt(1000))
        add('value', 'A percentage is between -100 and 1000');
    } else if (rule.adjustment === 'FIXED_AMOUNT') {
      if (value.isZero()) add('value', 'A change of 0 does nothing');
      else if (value.abs().gt('1e12')) add('value', 'Too large');
    } else if (value.isNegative()) {
      add('value', 'A rent cannot be negative');
    }
  }
  return issues;
}

const PriceRuleFields = {
  name: Name(80),
  kind: PriceRuleKindSchema,
  spaceId: Id.nullable().optional(),
  slotId: Id.nullable().optional(),
  daysOfWeek: DaysOfWeek.optional(),
  startDate: DateOnlySchema.nullable().optional(),
  endDate: DateOnlySchema.nullable().optional(),
  adjustment: AdjustmentKindSchema,
  value: SignedDecimalSchema,
  priority: z.number().int().min(-1000).max(1000),
};

/**
 * POST /v1/price-rules. `spaceId` / `slotId` limit the rule (empty = all). The space and slot must exist, and belong to
 * the same venue when both are given (checked in the service).
 */
export const CreatePriceRuleSchema = z
  .object({ ...PriceRuleFields, priority: PriceRuleFields.priority.default(0) })
  .superRefine((v, ctx) => {
    for (const issue of priceRuleShapeIssues({ ...v, daysOfWeek: v.daysOfWeek ?? [] })) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type CreatePriceRuleInput = z.infer<typeof CreatePriceRuleSchema>;

/**
 * PATCH /v1/price-rules/{id}. The merged rule is validated like a new one in the service. `active: false` is the soft
 * delete.
 */
export const UpdatePriceRuleSchema = z
  .object({
    rev: Rev,
    name: PriceRuleFields.name.optional(),
    kind: PriceRuleFields.kind.optional(),
    spaceId: PriceRuleFields.spaceId,
    slotId: PriceRuleFields.slotId,
    daysOfWeek: PriceRuleFields.daysOfWeek,
    startDate: PriceRuleFields.startDate,
    endDate: PriceRuleFields.endDate,
    adjustment: PriceRuleFields.adjustment.optional(),
    value: PriceRuleFields.value.optional(),
    priority: PriceRuleFields.priority.optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdatePriceRuleInput = z.infer<typeof UpdatePriceRuleSchema>;

// ───────────────────────────── rent preview ─────────────────────────────

/** GET /v1/pricing/rent-preview */
export const RentPreviewQuerySchema = z.object({
  venueId: Id,
  spaceId: Id,
  slotId: Id,
  /** The event day, venue-local `YYYY-MM-DD`. */
  date: DateOnlySchema,
  /** HOURLY slots only: the hours booked (up to 2 decimals). */
  hours: z
    .string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Use hours like 5 or 5.5')
    .optional(),
});
export type RentPreviewQuery = z.infer<typeof RentPreviewQuerySchema>;

export const RentPreviewLineSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  kind: PriceRuleKindSchema,
  adjustment: AdjustmentKindSchema,
  /** The rule's own value (a percentage, an amount, or the override rent). */
  value: z.string(),
  /** The effect on the rent, signed, rounded to the currency's minor unit (an `ADJUSTMENT` line of a quotation). */
  amount: z.string(),
  /** The rent after this rule. */
  rentAfter: z.string(),
});
export type RentPreviewLine = z.infer<typeof RentPreviewLineSchema>;

export const RentPreviewSchema = z.object({
  currency: z.string(),
  venueId: z.string(),
  spaceId: z.string(),
  slotId: z.string(),
  date: z.string(),
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: z.number().int(),
  slotMode: z.enum(['FIXED', 'HOURLY', 'FULL_DAY']),
  /** HOURLY only. */
  hours: z.string().nullable(),
  /** The rent of one slot (per hour for an HOURLY slot) before any rule. */
  unitRent: z.string(),
  /** Where `unitRent` comes from: the space's price for this slot, else the space's base rent. */
  baseSource: z.enum(['SLOT_PRICE', 'SPACE_BASE_RENT']),
  /** `unitRent` (x hours for HOURLY), rounded. */
  baseRent: z.string(),
  /** Every rule that applied, in the order applied. */
  adjustments: z.array(RentPreviewLineSchema),
  /** Matching overrides that lost to a higher-priority one (shown, never applied). */
  notApplied: z.array(z.object({ ruleId: z.string(), name: z.string() })),
  finalRent: z.string(),
});
export type RentPreviewDto = z.infer<typeof RentPreviewSchema>;

// ───────────────────────────── tax rates ─────────────────────────────

export const TaxRateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Percent with 2 decimals, e.g. "16.00". */
  ratePct: z.string(),
  /** true: prices already contain the tax (docs/05 section 3, inclusive rounding). */
  inclusive: z.boolean(),
  /** The rate new quotations use. At most one per workspace. */
  isDefault: z.boolean(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaxRateDto = z.infer<typeof TaxRateSchema>;
export const TaxRateListResponseSchema = listOf(TaxRateSchema);
export type TaxRateListResponse = z.infer<typeof TaxRateListResponseSchema>;

export const TaxRateListQuerySchema = z.object({ includeInactive: IncludeInactive });

const RatePct = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage like 16 or 16.5')
  .refine((v) => Number(v) <= 100, 'At most 100');

/** POST /v1/tax-rates. `isDefault: true` takes the flag from the current default. */
export const CreateTaxRateSchema = z.object({
  name: Name(60),
  ratePct: RatePct,
  inclusive: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export type CreateTaxRateInput = z.infer<typeof CreateTaxRateSchema>;

/** PATCH /v1/tax-rates/{id}. `isDefault: false` on the default leaves no default; `active: false` clears the flag too. */
export const UpdateTaxRateSchema = z
  .object({
    rev: Rev,
    name: Name(60).optional(),
    ratePct: RatePct.optional(),
    inclusive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdateTaxRateInput = z.infer<typeof UpdateTaxRateSchema>;

// ───────────────────────────── cancellation policies ─────────────────────────────

export const CancellationTierSchema = z.object({
  /** The tier applies when the cancellation is at least this many days before the first session. */
  minDaysBefore: z.number().int().min(0).max(3650),
  /** Share of the money received that is refunded (0 to 100, at most 2 decimals). */
  refundPct: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'At most 2 decimals'),
});
export type CancellationTier = z.infer<typeof CancellationTierSchema>;

/**
 * Tiers are sent from the longest notice to the shortest (docs/05 section 6): `minDaysBefore` strictly descending
 * (so unique) and the last tier is 0 days, so every cancellation falls in one tier. Returns the problems found.
 */
export function cancellationTierIssues(tiers: readonly CancellationTier[]): ShapeIssue[] {
  const issues: ShapeIssue[] = [];
  if (tiers.length === 0) return [{ path: '', message: 'At least one tier' }];
  for (let i = 1; i < tiers.length; i++) {
    const prev = (tiers[i - 1] as CancellationTier).minDaysBefore;
    const here = (tiers[i] as CancellationTier).minDaysBefore;
    if (here === prev) {
      issues.push({ path: `${i}.minDaysBefore`, message: 'Each number of days once' });
    } else if (here > prev) {
      issues.push({
        path: `${i}.minDaysBefore`,
        message: 'Order the tiers from most to fewest days',
      });
    }
  }
  if ((tiers[tiers.length - 1] as CancellationTier).minDaysBefore !== 0) {
    issues.push({
      path: `${tiers.length - 1}.minDaysBefore`,
      message: 'The last tier must be 0 days',
    });
  }
  return issues;
}

const Tiers = z
  .array(CancellationTierSchema)
  .min(1)
  .max(20)
  .superRefine((tiers, ctx) => {
    for (const issue of cancellationTierIssues(tiers)) {
      ctx.addIssue({
        code: 'custom',
        path:
          issue.path === ''
            ? []
            : issue.path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
        message: issue.message,
      });
    }
  });

export const CancellationPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  tiers: z.array(CancellationTierSchema),
  /** The policy new bookings use. At most one per workspace. */
  isDefault: z.boolean(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CancellationPolicyDto = z.infer<typeof CancellationPolicySchema>;
export const CancellationPolicyListResponseSchema = listOf(CancellationPolicySchema);
export type CancellationPolicyListResponse = z.infer<typeof CancellationPolicyListResponseSchema>;

export const CancellationPolicyListQuerySchema = z.object({ includeInactive: IncludeInactive });

/** POST /v1/cancellation-policies */
export const CreateCancellationPolicySchema = z.object({
  name: Name(80),
  tiers: Tiers,
  isDefault: z.boolean().default(false),
});
export type CreateCancellationPolicyInput = z.infer<typeof CreateCancellationPolicySchema>;

/** PATCH /v1/cancellation-policies/{id}. A booking keeps the copy it took at confirmation. */
export const UpdateCancellationPolicySchema = z
  .object({
    rev: Rev,
    name: Name(80).optional(),
    tiers: Tiers.optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdateCancellationPolicyInput = z.infer<typeof UpdateCancellationPolicySchema>;
