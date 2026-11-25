import { describe, expect, it } from 'vitest';
import {
  CreateAddOnSchema,
  CreateCustomFieldDefSchema,
  CreatePackageSchema,
  UpdateMenuItemSchema,
} from './catalogue.js';

describe('catalogue schemas', () => {
  it('a package has unique dishes with a quantity of at least 1', () => {
    const base = { name: 'Menu A', perHeadRate: '1500' };
    expect(CreatePackageSchema.safeParse(base).data?.items).toEqual([]);
    expect(
      CreatePackageSchema.safeParse({
        ...base,
        items: [
          { menuItemId: 'a', quantity: 2 },
          { menuItemId: 'a', quantity: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreatePackageSchema.safeParse({ ...base, items: [{ menuItemId: 'a', quantity: 0 }] }).success,
    ).toBe(false);
    expect(CreatePackageSchema.safeParse({ ...base, perHeadRate: '-5' }).success).toBe(false);
  });

  it('an add-on has one of the four pricings', () => {
    for (const pricing of ['FIXED', 'PER_HEAD', 'PER_HOUR', 'PER_UNIT']) {
      expect(CreateAddOnSchema.safeParse({ name: 'DJ', pricing, price: '5000' }).success).toBe(
        true,
      );
    }
    expect(
      CreateAddOnSchema.safeParse({ name: 'DJ', pricing: 'PER_DAY', price: '5000' }).success,
    ).toBe(false);
  });

  it('a patch must change something', () => {
    expect(UpdateMenuItemSchema.safeParse({ rev: 1 }).success).toBe(false);
    expect(UpdateMenuItemSchema.safeParse({ rev: 1, active: false }).success).toBe(true);
  });

  it('a custom field: choices only on select, sensitive only on text-like types', () => {
    const base = { entity: 'customer', key: 'cnic', label: 'CNIC', type: 'text' };
    expect(CreateCustomFieldDefSchema.safeParse({ ...base, sensitive: true }).success).toBe(true);
    expect(
      CreateCustomFieldDefSchema.safeParse({ ...base, type: 'date', sensitive: true }).success,
    ).toBe(false);
    expect(
      CreateCustomFieldDefSchema.safeParse({ ...base, entity: 'lead', sensitive: true }).success,
    ).toBe(false);
    expect(CreateCustomFieldDefSchema.safeParse({ ...base, type: 'select' }).success).toBe(false);
    expect(
      CreateCustomFieldDefSchema.safeParse({ ...base, type: 'select', options: ['A', 'a'] })
        .success,
    ).toBe(false);
    expect(
      CreateCustomFieldDefSchema.safeParse({ ...base, type: 'select', options: ['Bride', 'Groom'] })
        .success,
    ).toBe(true);
    expect(CreateCustomFieldDefSchema.safeParse({ ...base, options: ['x'] }).success).toBe(false);
    expect(CreateCustomFieldDefSchema.safeParse({ ...base, key: 'Bad Key' }).success).toBe(false);
  });
});
