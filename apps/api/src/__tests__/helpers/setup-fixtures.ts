import type { TenantStatus } from '@venueos/db';
import type { SlotTemplateDto, SpaceDto, VenueDto, EventTypeDto } from '@venueos/shared';
import type { TestApp } from './create-test-app';
import { authHeader } from './test-auth';
import { World } from './world';
import type { TestTenant } from './world';

// Fixtures for the module 1 specs (venues, spaces, slots, event types, settings): a tenant with an Owner and a
// caller, plus helpers that create the records through the API itself (so they exercise the real rules).

export interface Caller {
  tenant: TestTenant;
  /** Headers of the caller (the Owner unless `role` says otherwise). */
  auth: Record<string, string>;
  ownerAuth: Record<string, string>;
  userId: string;
}

export async function setupCaller(
  world: World,
  t: TestApp,
  options: {
    role?: Parameters<World['addMember']>[1];
    plan?: 'starter' | 'growth' | 'enterprise' | null;
    status?: TenantStatus;
  } = {},
): Promise<Caller> {
  const tenant = await world.createTenant({
    ...(options.plan === undefined ? { plan: 'enterprise' as const } : { plan: options.plan }),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  const owner = await world.addMember(tenant, { role: 'owner' });
  const ownerAuth = t.as(authHeader(owner.userId, tenant.id));
  if (options.role === undefined || options.role.role === 'owner') {
    return { tenant, auth: ownerAuth, ownerAuth, userId: owner.userId };
  }
  const member = await world.addMember(tenant, options.role);
  return {
    tenant,
    auth: t.as(authHeader(member.userId, tenant.id)),
    ownerAuth,
    userId: member.userId,
  };
}

export const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;

export async function makeVenue(
  t: TestApp,
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<VenueDto> {
  const res = await t
    .http()
    .post('/v1/venues')
    .set(auth)
    .send({ name: 'Grand Hall', ...body });
  if (res.status !== 201) throw new Error(`makeVenue: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as VenueDto;
}

export async function makeSpace(
  t: TestApp,
  auth: Record<string, string>,
  venueId: string,
  body: Record<string, unknown> = {},
): Promise<SpaceDto> {
  const res = await t
    .http()
    .post('/v1/spaces')
    .set(auth)
    .send({ venueId, name: 'Hall A', capacitySeated: 400, ...body });
  if (res.status !== 201) throw new Error(`makeSpace: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as SpaceDto;
}

export async function makeSlot(
  t: TestApp,
  auth: Record<string, string>,
  venueId: string,
  body: Record<string, unknown> = {},
): Promise<SlotTemplateDto> {
  const res = await t
    .http()
    .post('/v1/slot-templates')
    .set(auth)
    .send({ venueId, name: 'Lunch', mode: 'FIXED', startTime: '12:00', endTime: '16:00', ...body });
  if (res.status !== 201) throw new Error(`makeSlot: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as SlotTemplateDto;
}

export async function makeEventType(
  t: TestApp,
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<EventTypeDto> {
  const res = await t
    .http()
    .post('/v1/event-types')
    .set(auth)
    .send({ name: 'Walima', ...body });
  if (res.status !== 201) {
    throw new Error(`makeEventType: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as EventTypeDto;
}

/** Headers of a Branch manager limited to `venueIds` (a venue-scoped caller). */
export async function scopedManagerAuth(
  world: World,
  t: TestApp,
  tenant: TestTenant,
  venueIds: string[],
): Promise<Record<string, string>> {
  const member = await world.addMember(tenant, { role: 'branch_manager', venueIds });
  return t.as(authHeader(member.userId, tenant.id));
}
