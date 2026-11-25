import { describe, expect, it } from 'vitest';
import { TenantSettings } from '../tenant-settings.js';
import {
  CreateSlotTemplateSchema,
  CreateSpaceSchema,
  CreateVenueSchema,
  TenantSettingsPatchSchema,
  UpdateTenantSettingsSchema,
  UpdateVenueSchema,
} from './setup.js';

describe('TenantSettingsPatchSchema', () => {
  it('names exactly the keys of TenantSettings, and fills no defaults', () => {
    expect(Object.keys(TenantSettingsPatchSchema.shape).sort()).toEqual(
      Object.keys(TenantSettings.shape).sort(),
    );
    // A patch of one key stays a patch of one key (a default would reset the others).
    expect(TenantSettingsPatchSchema.parse({ holdHours: 12 })).toEqual({ holdHours: 12 });
    expect(TenantSettingsPatchSchema.parse({})).toEqual({});
  });

  it('keeps the range rules of the full schema', () => {
    expect(TenantSettingsPatchSchema.safeParse({ advancePct: 101 }).success).toBe(false);
    expect(TenantSettingsPatchSchema.safeParse({ bookingPrefix: 'a b' }).success).toBe(false);
  });
});

describe('UpdateTenantSettingsSchema', () => {
  it('needs rev and at least one change; currency and country are not accepted', () => {
    expect(UpdateTenantSettingsSchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(UpdateTenantSettingsSchema.safeParse({ rev: 1 }).success).toBe(false);
    const parsed = UpdateTenantSettingsSchema.parse({ rev: 1, name: 'X', currency: 'USD' });
    expect(parsed).toEqual({ rev: 1, name: 'X' });
  });
});

describe('venue schemas', () => {
  it('opening hours are both or neither', () => {
    expect(CreateVenueSchema.safeParse({ name: 'V', opensAt: '10:00' }).success).toBe(false);
    expect(
      CreateVenueSchema.safeParse({ name: 'V', opensAt: '10:00', closesAt: '02:00' }).success,
    ).toBe(true);
    expect(UpdateVenueSchema.safeParse({ rev: 1, opensAt: '10:00', closesAt: null }).success).toBe(
      false,
    );
    // Only one named in a patch: completed against the stored venue by the service.
    expect(UpdateVenueSchema.safeParse({ rev: 1, opensAt: '10:00' }).success).toBe(true);
  });
});

describe('space schema', () => {
  const base = { venueId: 'v1', name: 'Hall' };
  it('a combined space needs 2+ distinct components; a physical one has none', () => {
    expect(CreateSpaceSchema.safeParse({ ...base, isCombined: true }).success).toBe(false);
    expect(
      CreateSpaceSchema.safeParse({ ...base, isCombined: true, componentIds: ['a'] }).success,
    ).toBe(false);
    expect(
      CreateSpaceSchema.safeParse({ ...base, isCombined: true, componentIds: ['a', 'a'] }).success,
    ).toBe(false);
    expect(
      CreateSpaceSchema.safeParse({ ...base, isCombined: true, componentIds: ['a', 'b'] }).success,
    ).toBe(true);
    expect(CreateSpaceSchema.safeParse({ ...base, componentIds: ['a', 'b'] }).success).toBe(false);
    expect(CreateSpaceSchema.parse(base)).toMatchObject({ isCombined: false, kind: 'HALL' });
  });
});

describe('slot template schema', () => {
  const base = { venueId: 'v1', name: 'Lunch' };
  it('FIXED needs different times; FULL_DAY has none; minHours is for HOURLY', () => {
    expect(CreateSlotTemplateSchema.safeParse({ ...base, mode: 'FIXED' }).success).toBe(false);
    expect(
      CreateSlotTemplateSchema.safeParse({
        ...base,
        mode: 'FIXED',
        startTime: '12:00',
        endTime: '12:00',
      }).success,
    ).toBe(false);
    expect(
      CreateSlotTemplateSchema.safeParse({
        ...base,
        mode: 'FIXED',
        startTime: '12:00',
        endTime: '16:00',
      }).success,
    ).toBe(true);
    expect(CreateSlotTemplateSchema.safeParse({ ...base, mode: 'FULL_DAY' }).success).toBe(true);
    expect(
      CreateSlotTemplateSchema.safeParse({ ...base, mode: 'FULL_DAY', startTime: '10:00' }).success,
    ).toBe(false);
    expect(
      CreateSlotTemplateSchema.safeParse({ ...base, mode: 'HOURLY', minHours: 2 }).success,
    ).toBe(true);
    expect(
      CreateSlotTemplateSchema.safeParse({ ...base, mode: 'FULL_DAY', minHours: 2 }).success,
    ).toBe(false);
  });
});
