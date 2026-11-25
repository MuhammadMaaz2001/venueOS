'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateCustomerInput, UpdateCustomerInput } from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

export const customerKeys = {
  all: ['customers'] as const,
  list: (search: string, includeInactive: boolean) =>
    ['customers', 'list', { search, includeInactive }] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
  duplicates: (phone: string, email: string, excludeId: string) =>
    ['customers', 'duplicates', { phone, email, excludeId }] as const,
};

export const CUSTOMER_MESSAGES: ErrorMessageOverrides = {
  VERSION_CONFLICT: 'Customers.errors.changedByOthers',
};
const FORM = { silent: false, errorMessages: CUSTOMER_MESSAGES } as const;

/** `GET /v1/customers`, page after page (cursor). `enabled: false` for people without `customer.view`. */
export function useCustomers(options: {
  search: string;
  includeInactive?: boolean;
  enabled?: boolean;
}) {
  const includeInactive = options.includeInactive ?? false;
  return useInfiniteQuery({
    queryKey: customerKeys.list(options.search, includeInactive),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/customers', {
          params: {
            query: {
              limit: 25,
              ...(options.search === '' ? {} : { search: options.search }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              ...(includeInactive ? { includeInactive: 'true' as const } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/customers/{id}`: the customer, their leads and possible duplicates. */
export function useCustomer(id: string) {
  return useQuery({
    queryKey: customerKeys.detail(id),
    queryFn: () => unwrap(api.GET('/v1/customers/{id}', { params: { path: { id } } })),
  });
}

/**
 * `GET /v1/customers/duplicates`: runs while a form is open, once the phone or email is complete. A failed check
 * is silent: the warning is a convenience, never a blocker.
 */
export function useCustomerDuplicates(options: {
  phone: string;
  email: string;
  excludeId?: string | undefined;
  enabled: boolean;
}) {
  const excludeId = options.excludeId ?? '';
  return useQuery({
    queryKey: customerKeys.duplicates(options.phone, options.email, excludeId),
    queryFn: () =>
      unwrap(
        api.GET('/v1/customers/duplicates', {
          params: {
            query: {
              ...(options.phone === '' ? {} : { phone: options.phone }),
              ...(options.email === '' ? {} : { email: options.email }),
              ...(excludeId === '' ? {} : { excludeId }),
            },
          },
        }),
      ),
    enabled: options.enabled && (options.phone !== '' || options.email !== ''),
    meta: { silent: true },
    staleTime: 10_000,
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCustomerInput) => unwrap(api.POST('/v1/customers', { body })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: customerKeys.all }),
    meta: FORM,
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateCustomerInput & { id: string }) =>
      unwrap(api.PATCH('/v1/customers/{id}', { params: { path: { id } }, body })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: customerKeys.all }),
    meta: FORM,
  });
}

/** `POST /v1/customers/{id}/reveal/{fieldKey}`: the clear value of a sensitive field (audited by the API). */
export function useRevealCustomerField() {
  return useMutation({
    mutationFn: ({ id, fieldKey }: { id: string; fieldKey: string }) =>
      unwrap(
        api.POST('/v1/customers/{id}/reveal/{fieldKey}', {
          params: { path: { id, fieldKey } },
        }),
      ),
  });
}

/** `GET /v1/custom-fields?entity=...`: the fields a form shows. */
export function useCustomFieldDefs(entity: 'customer' | 'lead', enabled = true) {
  return useQuery({
    queryKey: ['catalogue', 'custom-fields', 'form', entity],
    queryFn: () =>
      unwrap(
        api.GET('/v1/custom-fields', { params: { query: { entity, includeInactive: 'true' } } }),
      ),
    enabled,
    // A person without `catalogue.view` gets 403 here and simply sees no custom fields.
    meta: { silent: true },
    retry: false,
  });
}
