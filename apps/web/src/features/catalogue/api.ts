'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateAddOnInput,
  CreateCustomFieldDefInput,
  CreateMenuItemInput,
  CreatePackageInput,
  CustomFieldEntity,
  UpdateAddOnInput,
  UpdateCustomFieldDefInput,
  UpdateMenuItemInput,
  UpdatePackageInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

export const catalogueKeys = {
  menuItems: ['catalogue', 'menu-items'] as const,
  packages: ['catalogue', 'packages'] as const,
  addOns: ['catalogue', 'add-ons'] as const,
  customFields: ['catalogue', 'custom-fields'] as const,
};

/** A taken name, a stale form and "only staff with access to all venues" have their own words on these forms. */
export const CATALOGUE_MESSAGES: ErrorMessageOverrides = {
  DUPLICATE: 'Catalogue.errors.duplicate',
  VERSION_CONFLICT: 'Catalogue.errors.changedByOthers',
  FORBIDDEN: 'Catalogue.errors.forbidden',
};

const FORM = { silent: false, errorMessages: CATALOGUE_MESSAGES } as const;

// ───────────────────────────── queries ─────────────────────────────

/** `GET /v1/menu-items`. `enabled: false` for people without `catalogue.view` (the API would answer 403). */
export function useMenuItems(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...catalogueKeys.menuItems, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/menu-items', { params: { query: { includeInactive: `${includeInactive}` } } }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/packages`. */
export function usePackages(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...catalogueKeys.packages, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/packages', { params: { query: { includeInactive: `${includeInactive}` } } }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/add-ons`. */
export function useAddOns(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...catalogueKeys.addOns, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/add-ons', { params: { query: { includeInactive: `${includeInactive}` } } }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/custom-fields`. */
export function useCustomFields(
  options: { entity?: CustomFieldEntity; includeInactive?: boolean; enabled?: boolean } = {},
) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...catalogueKeys.customFields, { entity: options.entity, includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/custom-fields', {
          params: {
            query: {
              includeInactive: `${includeInactive}`,
              ...(options.entity === undefined ? {} : { entity: options.entity }),
            },
          },
        }),
      ),
    enabled: options.enabled ?? true,
  });
}

// ───────────────────────────── mutations ─────────────────────────────
// A form shows the field messages itself (`silent: false` hands 400s to the form); every other failure is the global
// toast, worded by CATALOGUE_MESSAGES. Packages also depend on the dishes, so a dish change reloads both.

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

export function useCreateMenuItem() {
  return useInvalidating(
    (body: CreateMenuItemInput) => unwrap(api.POST('/v1/menu-items', { body })),
    [catalogueKeys.menuItems],
  );
}

export function useUpdateMenuItem() {
  return useInvalidating(
    ({ id, ...body }: UpdateMenuItemInput & { id: string }) =>
      unwrap(api.PATCH('/v1/menu-items/{id}', { params: { path: { id } }, body })),
    [catalogueKeys.menuItems, catalogueKeys.packages],
  );
}

export function useCreatePackage() {
  return useInvalidating(
    (body: CreatePackageInput) => unwrap(api.POST('/v1/packages', { body })),
    [catalogueKeys.packages],
  );
}

export function useUpdatePackage() {
  return useInvalidating(
    ({ id, ...body }: UpdatePackageInput & { id: string }) =>
      unwrap(api.PATCH('/v1/packages/{id}', { params: { path: { id } }, body })),
    [catalogueKeys.packages],
  );
}

export function useCreateAddOn() {
  return useInvalidating(
    (body: CreateAddOnInput) => unwrap(api.POST('/v1/add-ons', { body })),
    [catalogueKeys.addOns],
  );
}

export function useUpdateAddOn() {
  return useInvalidating(
    ({ id, ...body }: UpdateAddOnInput & { id: string }) =>
      unwrap(api.PATCH('/v1/add-ons/{id}', { params: { path: { id } }, body })),
    [catalogueKeys.addOns],
  );
}

export function useCreateCustomField() {
  return useInvalidating(
    (body: CreateCustomFieldDefInput) => unwrap(api.POST('/v1/custom-fields', { body })),
    [catalogueKeys.customFields],
  );
}

export function useUpdateCustomField() {
  return useInvalidating(
    ({ id, ...body }: UpdateCustomFieldDefInput & { id: string }) =>
      unwrap(api.PATCH('/v1/custom-fields/{id}', { params: { path: { id } }, body })),
    [catalogueKeys.customFields],
  );
}
