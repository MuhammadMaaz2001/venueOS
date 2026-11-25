import { z } from 'zod';
import {
  Id,
  IncludeInactive,
  IsoDateTime,
  Name,
  OptionalText,
  Rev,
  hasChange,
  listOf,
} from './common.js';
import { MoneyStringSchema } from './setup.js';

// Module 3, catalogue (docs/01 module 3): menu items, packages, add-ons and custom field definitions. All of it is
// tenant-wide. Prices are strings with the tenant currency's decimals, or `null` when the caller may not see prices
// (docs/04 section 2: `catalogue.manage` or `booking.view_prices`).

const NOTHING = { message: 'Nothing to change' } as const;
const Category = z.string().trim().min(1).max(60);

// ───────────────────────────── menu items ─────────────────────────────

export const MenuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Free text (Starter, Main, Dessert, Drink ...). */
  category: z.string().nullable(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MenuItemDto = z.infer<typeof MenuItemSchema>;
export const MenuItemListResponseSchema = listOf(MenuItemSchema);
export type MenuItemListResponse = z.infer<typeof MenuItemListResponseSchema>;

export const MenuItemListQuerySchema = z.object({
  includeInactive: IncludeInactive,
  category: Category.optional(),
});

/** POST /v1/menu-items */
export const CreateMenuItemSchema = z.object({
  name: Name(100),
  category: Category.nullable().optional(),
});
export type CreateMenuItemInput = z.infer<typeof CreateMenuItemSchema>;

/** PATCH /v1/menu-items/{id}. `active: false` is the soft delete. */
export const UpdateMenuItemSchema = z
  .object({
    rev: Rev,
    name: Name(100).optional(),
    category: Category.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdateMenuItemInput = z.infer<typeof UpdateMenuItemSchema>;

// ───────────────────────────── packages ─────────────────────────────

export const PackageItemSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  quantity: z.number().int(),
  /** False when the menu item was deactivated after it was put in the package. */
  menuItemActive: z.boolean(),
});
export type PackageItemDto = z.infer<typeof PackageItemSchema>;

export const PackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Price per guest; `null` for callers who may not see prices. */
  perHeadRate: z.string().nullable(),
  /** Guests billed at least (docs/05 section 3). */
  minGuests: z.number().int(),
  description: z.string().nullable(),
  items: z.array(PackageItemSchema),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PackageDto = z.infer<typeof PackageSchema>;
export const PackageListResponseSchema = listOf(PackageSchema);
export type PackageListResponse = z.infer<typeof PackageListResponseSchema>;

export const PackageListQuerySchema = z.object({ includeInactive: IncludeInactive });

const MinGuests = z.number().int().min(0).max(100000);
const PackageItemInput = z.object({
  menuItemId: Id,
  quantity: z.number().int().min(1).max(1000).default(1),
});
const PackageItems = z
  .array(PackageItemInput)
  .max(100)
  .refine(
    (items) => new Set(items.map((i) => i.menuItemId)).size === items.length,
    'Each dish once',
  );

/** POST /v1/packages. The menu items must exist and be active (checked in the service). */
export const CreatePackageSchema = z.object({
  name: Name(100),
  perHeadRate: MoneyStringSchema,
  minGuests: MinGuests.default(0),
  description: OptionalText(1000).optional(),
  items: PackageItems.default([]),
});
export type CreatePackageInput = z.infer<typeof CreatePackageSchema>;

/** PATCH /v1/packages/{id}. `items`, when sent, REPLACES the whole item list. `active: false` is the soft delete. */
export const UpdatePackageSchema = z
  .object({
    rev: Rev,
    name: Name(100).optional(),
    perHeadRate: MoneyStringSchema.optional(),
    minGuests: MinGuests.optional(),
    description: OptionalText(1000).optional(),
    items: PackageItems.optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdatePackageInput = z.infer<typeof UpdatePackageSchema>;

// ───────────────────────────── add-ons ─────────────────────────────

/** docs/05 section 3: FIXED = price; PER_HEAD = price x billed guests; PER_HOUR = price x hours; PER_UNIT = price x quantity. */
export const ADD_ON_PRICINGS = ['FIXED', 'PER_HEAD', 'PER_HOUR', 'PER_UNIT'] as const;
export const AddOnPricingSchema = z.enum(ADD_ON_PRICINGS);
export type AddOnPricing = z.infer<typeof AddOnPricingSchema>;

export const AddOnSchema = z.object({
  id: z.string(),
  name: z.string(),
  pricing: AddOnPricingSchema,
  /** `null` for callers who may not see prices. */
  price: z.string().nullable(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AddOnDto = z.infer<typeof AddOnSchema>;
export const AddOnListResponseSchema = listOf(AddOnSchema);
export type AddOnListResponse = z.infer<typeof AddOnListResponseSchema>;

export const AddOnListQuerySchema = z.object({ includeInactive: IncludeInactive });

/** POST /v1/add-ons. The vendor link arrives with the vendors module; it stays empty until then. */
export const CreateAddOnSchema = z.object({
  name: Name(100),
  pricing: AddOnPricingSchema,
  price: MoneyStringSchema,
});
export type CreateAddOnInput = z.infer<typeof CreateAddOnSchema>;

/** PATCH /v1/add-ons/{id}. `active: false` is the soft delete. */
export const UpdateAddOnSchema = z
  .object({
    rev: Rev,
    name: Name(100).optional(),
    pricing: AddOnPricingSchema.optional(),
    price: MoneyStringSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdateAddOnInput = z.infer<typeof UpdateAddOnSchema>;

// ───────────────────────────── custom field definitions ─────────────────────────────

/** Records a tenant-defined field can be added to. The values live on those records (module 4 onwards). */
export const CUSTOM_FIELD_ENTITIES = ['customer', 'booking', 'session', 'lead'] as const;
export const CustomFieldEntitySchema = z.enum(CUSTOM_FIELD_ENTITIES);
export type CustomFieldEntity = z.infer<typeof CustomFieldEntitySchema>;

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'phone'] as const;
export const CustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

/** Types a `sensitive` (encrypted, masked) value may have. */
export const SENSITIVE_FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'phone'];

export const CustomFieldDefSchema = z.object({
  id: z.string(),
  entity: CustomFieldEntitySchema,
  /** Machine name the values are stored under; fixed after creation. */
  key: z.string(),
  label: z.string(),
  type: CustomFieldTypeSchema,
  /** The choices of a `select` field; empty for every other type. */
  options: z.array(z.string()),
  required: z.boolean(),
  /** Encrypted at rest and masked unless the viewer has `customer.view_sensitive` (docs/04 section 6). */
  sensitive: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CustomFieldDefDto = z.infer<typeof CustomFieldDefSchema>;
export const CustomFieldDefListResponseSchema = listOf(CustomFieldDefSchema);
export type CustomFieldDefListResponse = z.infer<typeof CustomFieldDefListResponseSchema>;

export const CustomFieldDefListQuerySchema = z.object({
  entity: CustomFieldEntitySchema.optional(),
  includeInactive: IncludeInactive,
});

const FieldKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,39}$/,
    'Lower-case letters, digits and underscores, starting with a letter',
  );
const FieldOptions = z
  .array(Name(80))
  .max(50)
  .refine((o) => new Set(o.map((x) => x.toLowerCase())).size === o.length, 'Each choice once');

/** POST /v1/custom-fields. A `select` needs choices; the other types have none; only text, number and phone may be sensitive. */
export const CreateCustomFieldDefSchema = z
  .object({
    entity: CustomFieldEntitySchema,
    key: FieldKey,
    label: Name(80),
    type: CustomFieldTypeSchema,
    options: FieldOptions.default([]),
    required: z.boolean().default(false),
    sensitive: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'select' && v.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'A choice field needs choices' });
    }
    if (v.type !== 'select' && v.options.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only a choice field has choices',
      });
    }
    if (v.sensitive && !SENSITIVE_FIELD_TYPES.includes(v.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sensitive'],
        message: 'Only text, number and phone fields can be sensitive',
      });
    }
    // Sealing and revealing (module 4) exist for customers; the other records get it when they need it.
    if (v.sensitive && v.entity !== 'customer') {
      ctx.addIssue({
        code: 'custom',
        path: ['sensitive'],
        message: 'Only customer fields can be sensitive',
      });
    }
  });
export type CreateCustomFieldDefInput = z.infer<typeof CreateCustomFieldDefSchema>;

/**
 * PATCH /v1/custom-fields/{id}. Entity, key, type and sensitivity are fixed at creation (values already stored under
 * them would stop making sense); `options` only on a choice field. `active: false` is the soft delete.
 */
export const UpdateCustomFieldDefSchema = z
  .object({
    rev: Rev,
    label: Name(80).optional(),
    options: FieldOptions.optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine(hasChange, NOTHING);
export type UpdateCustomFieldDefInput = z.infer<typeof UpdateCustomFieldDefSchema>;
