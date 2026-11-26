'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BouncePaymentInput,
  CreateRefundRequestInput,
  DecideRefundInput,
  PayRefundInput,
  RecordPaymentInput,
  RefundStatus,
  RejectRefundInput,
  ReplaceScheduleInput,
  ReversePaymentInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';
import { bookingKeys } from '../bookings/api';

export const paymentKeys = {
  all: ['payments'] as const,
  overview: (bookingId: string) => ['payments', 'overview', bookingId] as const,
  refunds: (filters: RefundFilters) => ['payments', 'refunds', filters] as const,
  receivables: (filters: ReceivableFilters) => ['payments', 'receivables', filters] as const,
  summary: ['payments', 'summary'] as const,
};

export const PAYMENT_MESSAGES: ErrorMessageOverrides = {
  VERSION_CONFLICT: 'Payments.errors.changedByOthers',
  INVALID_STATE_TRANSITION: 'Payments.errors.stateNotAllowed',
  IDEMPOTENCY_CONFLICT: 'Payments.errors.idempotencyConflict',
  FORBIDDEN: 'Payments.errors.forbidden',
};
const FORM = { silent: false, errorMessages: PAYMENT_MESSAGES } as const;

export interface RefundFilters {
  status: RefundStatus | '';
}
export interface ReceivableFilters {
  venueId: string;
  from: string;
  to: string;
  overdue: boolean;
}
export const NO_RECEIVABLE_FILTERS: ReceivableFilters = {
  venueId: '',
  from: '',
  to: '',
  overdue: false,
};

/** A new client-made key per submission: a retry of the SAME submission reuses it, a new one gets a new one. */
export const newIdempotencyKey = (): string => `web-${crypto.randomUUID()}`;

/** The Payments tab of a booking: totals, schedule, entries, refund requests. */
export function usePaymentsOverview(bookingId: string, enabled = true) {
  return useQuery({
    queryKey: paymentKeys.overview(bookingId),
    queryFn: () =>
      unwrap(api.GET('/v1/bookings/{id}/payments', { params: { path: { id: bookingId } } })),
    enabled,
    // The receipt PDF is made by the worker a moment after a payment: look again until every receipt has it.
    refetchInterval: (query) =>
      query.state.data?.payments.some(
        (p) => p.entryType === 'RECEIPT' && p.status !== 'PENDING' && !p.receiptReady,
      )
        ? 3_000
        : false,
  });
}

/** Everything that depends on money: the tab, the booking (paid total), lists and the dashboard cards. */
function useRefreshMoney() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: paymentKeys.all }),
      queryClient.invalidateQueries({ queryKey: bookingKeys.all }),
    ]);
}

export function useRecordPayment(bookingId: string) {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: ({ key, ...body }: RecordPaymentInput & { key: string }) =>
      unwrap(
        api.POST('/v1/bookings/{id}/payments', {
          params: { path: { id: bookingId }, header: { 'Idempotency-Key': key } },
          body,
        }),
      ),
    onSettled: refresh,
    meta: FORM,
  });
}

export function useClearCheque() {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/v1/payments/{id}/clear', { params: { path: { id } } })),
    onSettled: refresh,
    meta: FORM,
  });
}

export function useBounceCheque() {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: ({ id, ...body }: BouncePaymentInput & { id: string }) =>
      unwrap(api.POST('/v1/payments/{id}/bounce', { params: { path: { id } }, body })),
    onSettled: refresh,
    meta: FORM,
  });
}

export function useReversePayment() {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: ({ id, key, ...body }: ReversePaymentInput & { id: string; key: string }) =>
      unwrap(
        api.POST('/v1/payments/{id}/reverse', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body,
        }),
      ),
    onSettled: refresh,
    meta: FORM,
  });
}

export function useReplaceSchedule(bookingId: string) {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: (body: ReplaceScheduleInput) =>
      unwrap(
        api.PUT('/v1/bookings/{id}/payment-schedule', {
          params: { path: { id: bookingId } },
          body,
        }),
      ),
    onSettled: refresh,
    meta: FORM,
  });
}

/** A fresh download link (they expire): fetched on click, never cached. */
export function fetchReceiptLink(id: string) {
  return unwrap(api.GET('/v1/payments/{id}/receipt', { params: { path: { id } } }));
}

export function useResendReceipt() {
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to?: string }) =>
      unwrap(
        api.POST('/v1/payments/{id}/receipt/resend', {
          params: { path: { id } },
          body: to ? { to } : {},
        }),
      ),
    meta: FORM,
  });
}

export function useRequestRefund(bookingId: string) {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: ({ key, ...body }: CreateRefundRequestInput & { key: string }) =>
      unwrap(
        api.POST('/v1/bookings/{id}/refund-requests', {
          params: { path: { id: bookingId }, header: { 'Idempotency-Key': key } },
          body,
        }),
      ),
    onSettled: refresh,
    meta: FORM,
  });
}

/** `GET /v1/refund-requests`, page after page. */
export function useRefundRequests(filters: RefundFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: paymentKeys.refunds(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/refund-requests', {
          params: {
            query: {
              limit: 25,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              ...(filters.status === '' ? {} : { status: filters.status }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useDecideRefund() {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: (
      input:
        | ({ action: 'approve'; id: string } & DecideRefundInput)
        | ({ action: 'reject'; id: string } & RejectRefundInput),
    ) => {
      const { id, action, ...body } = input;
      return action === 'approve'
        ? unwrap(
            api.POST('/v1/refund-requests/{id}/approve', {
              params: { path: { id } },
              body: body as DecideRefundInput,
            }),
          )
        : unwrap(
            api.POST('/v1/refund-requests/{id}/reject', {
              params: { path: { id } },
              body: body as RejectRefundInput,
            }),
          );
    },
    onSettled: refresh,
    meta: FORM,
  });
}

export function usePayRefund() {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: ({ id, key, ...body }: PayRefundInput & { id: string; key: string }) =>
      unwrap(
        api.POST('/v1/refund-requests/{id}/pay', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body,
        }),
      ),
    onSettled: refresh,
    meta: FORM,
  });
}

/** `GET /v1/receivables`, page after page. */
export function useReceivables(filters: ReceivableFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: paymentKeys.receivables(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/receivables', {
          params: {
            query: {
              limit: 25,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              ...(filters.venueId === '' ? {} : { venueId: filters.venueId }),
              ...(filters.from === '' ? {} : { from: filters.from }),
              ...(filters.to === '' ? {} : { to: filters.to }),
              ...(filters.overdue ? { overdue: 'true' as const } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

/** The dashboard cards: due this week and overdue. */
export function useReceivablesSummary(enabled = true) {
  return useQuery({
    queryKey: paymentKeys.summary,
    queryFn: () => unwrap(api.GET('/v1/receivables/summary')),
    enabled,
    refetchInterval: 120_000,
  });
}
