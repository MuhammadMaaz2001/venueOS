'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateEventTypeInput,
  CreateSlotTemplateInput,
  CreateSpaceInput,
  CreateVenueInput,
  ReplaceSpaceSlotPricesInput,
  UpdateEventTypeInput,
  UpdateSlotTemplateInput,
  UpdateSpaceInput,
  UpdateTenantSettingsInput,
  UpdateVenueInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';
import { meKeys } from '../me/api';

export const setupKeys = {
  venues: ['setup', 'venues'] as const,
  spaces: ['setup', 'spaces'] as const,
  slots: ['setup', 'slots'] as const,
  prices: (spaceId: string) => ['setup', 'prices', spaceId] as const,
  eventTypes: ['setup', 'event-types'] as const,
  settings: ['setup', 'settings'] as const,
};

/** The plan limit and a name that is taken have their own words on these forms. */
export const SETUP_MESSAGES: ErrorMessageOverrides = {
  PLAN_LIMIT_REACHED: 'Setup.errors.planLimit',
  DUPLICATE: 'Setup.errors.duplicate',
  INVALID_STATE_TRANSITION: 'Setup.errors.invalidState',
  VERSION_CONFLICT: 'Setup.errors.changedByOthers',
};

// ───────────────────────────── queries ─────────────────────────────

/** `GET /v1/venues`. `enabled: false` for people who may not manage venues (the API would answer 403). */
export function useVenues(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...setupKeys.venues, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/venues', { params: { query: { includeInactive: `${includeInactive}` } } }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/venues/{id}`. */
export function useVenue(id: string) {
  return useQuery({
    queryKey: [...setupKeys.venues, 'one', id],
    queryFn: () => unwrap(api.GET('/v1/venues/{id}', { params: { path: { id } } })),
  });
}

/** `GET /v1/spaces?venueId=`. */
export function useSpaces(
  venueId: string | undefined,
  options: { includeInactive?: boolean } = {},
) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...setupKeys.spaces, venueId, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/spaces', {
          params: { query: { venueId: venueId as string, includeInactive: `${includeInactive}` } },
        }),
      ),
    enabled: venueId !== undefined,
  });
}

/** `GET /v1/slot-templates?venueId=`. */
export function useSlots(venueId: string | undefined, options: { includeInactive?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...setupKeys.slots, venueId, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/slot-templates', {
          params: { query: { venueId: venueId as string, includeInactive: `${includeInactive}` } },
        }),
      ),
    enabled: venueId !== undefined,
  });
}

/** `GET /v1/spaces/{id}/slot-prices`. */
export function useSlotPrices(spaceId: string | undefined) {
  return useQuery({
    queryKey: setupKeys.prices(spaceId ?? ''),
    queryFn: () =>
      unwrap(
        api.GET('/v1/spaces/{id}/slot-prices', { params: { path: { id: spaceId as string } } }),
      ),
    enabled: spaceId !== undefined,
  });
}

/** `GET /v1/event-types`. */
export function useEventTypes(options: { includeInactive?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...setupKeys.eventTypes, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/event-types', {
          params: { query: { includeInactive: `${includeInactive}` } },
        }),
      ),
  });
}

/** `GET /v1/tenant/settings`. */
export function useTenantSettings() {
  return useQuery({
    queryKey: setupKeys.settings,
    queryFn: () => unwrap(api.GET('/v1/tenant/settings')),
  });
}

// ───────────────────────────── mutations ─────────────────────────────
// A form shows the field messages itself (`silent`); every other failure is the global toast, with the
// setup-specific wording of SETUP_MESSAGES. A 409 reloads what the form was built from.

const FORM = { silent: false, errorMessages: SETUP_MESSAGES } as const;

function useInvalidating<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  keys: readonly (readonly unknown[])[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
    meta: FORM,
  });
}

export function useCreateVenue() {
  return useInvalidating(
    (body: CreateVenueInput) => unwrap(api.POST('/v1/venues', { body })),
    [setupKeys.venues],
  );
}

export function useUpdateVenue() {
  return useInvalidating(
    ({ id, ...body }: UpdateVenueInput & { id: string }) =>
      unwrap(api.PATCH('/v1/venues/{id}', { params: { path: { id } }, body })),
    [setupKeys.venues, setupKeys.spaces, setupKeys.slots],
  );
}

export function useCreateSpace() {
  return useInvalidating(
    (body: CreateSpaceInput) => unwrap(api.POST('/v1/spaces', { body })),
    [setupKeys.spaces],
  );
}

export function useUpdateSpace() {
  return useInvalidating(
    ({ id, ...body }: UpdateSpaceInput & { id: string }) =>
      unwrap(api.PATCH('/v1/spaces/{id}', { params: { path: { id } }, body })),
    [setupKeys.spaces],
  );
}

export function useCreateSlot() {
  return useInvalidating(
    (body: CreateSlotTemplateInput) => unwrap(api.POST('/v1/slot-templates', { body })),
    [setupKeys.slots],
  );
}

export function useUpdateSlot() {
  return useInvalidating(
    ({ id, ...body }: UpdateSlotTemplateInput & { id: string }) =>
      unwrap(api.PATCH('/v1/slot-templates/{id}', { params: { path: { id } }, body })),
    [setupKeys.slots],
  );
}

export function useReplaceSlotPrices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, ...body }: ReplaceSpaceSlotPricesInput & { spaceId: string }) =>
      unwrap(api.PUT('/v1/spaces/{id}/slot-prices', { params: { path: { id: spaceId } }, body })),
    onSuccess: (data, { spaceId }) => queryClient.setQueryData(setupKeys.prices(spaceId), data),
    meta: FORM,
  });
}

export function useCreateEventType() {
  return useInvalidating(
    (body: CreateEventTypeInput) => unwrap(api.POST('/v1/event-types', { body })),
    [setupKeys.eventTypes],
  );
}

export function useUpdateEventType() {
  return useInvalidating(
    ({ id, ...body }: UpdateEventTypeInput & { id: string }) =>
      unwrap(api.PATCH('/v1/event-types/{id}', { params: { path: { id } }, body })),
    [setupKeys.eventTypes],
  );
}

/** `PATCH /v1/tenant/settings`; the workspace name and zone also live in `/v1/me/tenants`, so that reloads too. */
export function useUpdateTenantSettings() {
  return useInvalidating(
    (body: UpdateTenantSettingsInput) => unwrap(api.PATCH('/v1/tenant/settings', { body })),
    [setupKeys.settings, meKeys.tenants],
  );
}
