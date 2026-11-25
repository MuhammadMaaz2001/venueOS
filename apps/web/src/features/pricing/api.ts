'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCancellationPolicyInput,
  CreatePriceRuleInput,
  CreateTaxRateInput,
  RentPreviewQuery,
  UpdateCancellationPolicyInput,
  UpdatePriceRuleInput,
  UpdateTaxRateInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

export const pricingKeys = {
  priceRules: ['pricing', 'price-rules'] as const,
  taxRates: ['pricing', 'tax-rates'] as const,
  policies: ['pricing', 'cancellation-policies'] as const,
  preview: ['pricing', 'rent-preview'] as const,
};

/** A taken name, a stale form, a rule that cannot be priced and "only staff with all venues" have their own words. */
export const PRICING_MESSAGES: ErrorMessageOverrides = {
  DUPLICATE: 'Pricing.errors.duplicate',
  VERSION_CONFLICT: 'Pricing.errors.changedByOthers',
  FORBIDDEN: 'Pricing.errors.forbidden',
  INVALID_STATE_TRANSITION: 'Pricing.errors.noRent',
};

const FORM = { silent: false, errorMessages: PRICING_MESSAGES } as const;

// ───────────────────────────── queries ─────────────────────────────

/** `GET /v1/price-rules`. `enabled: false` for people without `pricing.view`. */
export function usePriceRules(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...pricingKeys.priceRules, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/price-rules', {
          params: { query: { includeInactive: `${includeInactive}` } },
        }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/tax-rates`. */
export function useTaxRates(options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...pricingKeys.taxRates, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/tax-rates', { params: { query: { includeInactive: `${includeInactive}` } } }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/cancellation-policies`. */
export function useCancellationPolicies(
  options: { includeInactive?: boolean; enabled?: boolean } = {},
) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: [...pricingKeys.policies, { includeInactive }],
    queryFn: () =>
      unwrap(
        api.GET('/v1/cancellation-policies', {
          params: { query: { includeInactive: `${includeInactive}` } },
        }),
      ),
    enabled: options.enabled ?? true,
  });
}

/** `GET /v1/pricing/rent-preview`. Runs only when the question is complete (`query` defined). */
export function useRentPreview(query: RentPreviewQuery | undefined) {
  return useQuery({
    queryKey: [...pricingKeys.preview, query],
    queryFn: () =>
      unwrap(api.GET('/v1/pricing/rent-preview', { params: { query: query as RentPreviewQuery } })),
    enabled: query !== undefined,
    // A rule edited elsewhere must show up: never reuse an old answer for long.
    staleTime: 0,
    // A 400/422 here is an answer ("not offered that day", "no rent set"), not a failure to retry.
    retry: false,
    meta: { silent: true },
  });
}

// ───────────────────────────── mutations ─────────────────────────────

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

export function useCreatePriceRule() {
  return useInvalidating(
    (body: CreatePriceRuleInput) => unwrap(api.POST('/v1/price-rules', { body })),
    [pricingKeys.priceRules, pricingKeys.preview],
  );
}

export function useUpdatePriceRule() {
  return useInvalidating(
    ({ id, ...body }: UpdatePriceRuleInput & { id: string }) =>
      unwrap(api.PATCH('/v1/price-rules/{id}', { params: { path: { id } }, body })),
    [pricingKeys.priceRules, pricingKeys.preview],
  );
}

export function useCreateTaxRate() {
  return useInvalidating(
    (body: CreateTaxRateInput) => unwrap(api.POST('/v1/tax-rates', { body })),
    [pricingKeys.taxRates],
  );
}

export function useUpdateTaxRate() {
  return useInvalidating(
    ({ id, ...body }: UpdateTaxRateInput & { id: string }) =>
      unwrap(api.PATCH('/v1/tax-rates/{id}', { params: { path: { id } }, body })),
    [pricingKeys.taxRates],
  );
}

export function useCreateCancellationPolicy() {
  return useInvalidating(
    (body: CreateCancellationPolicyInput) =>
      unwrap(api.POST('/v1/cancellation-policies', { body })),
    [pricingKeys.policies],
  );
}

export function useUpdateCancellationPolicy() {
  return useInvalidating(
    ({ id, ...body }: UpdateCancellationPolicyInput & { id: string }) =>
      unwrap(api.PATCH('/v1/cancellation-policies/{id}', { params: { path: { id } }, body })),
    [pricingKeys.policies],
  );
}
