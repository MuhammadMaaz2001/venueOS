'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BookingStatus,
  CancelBookingInput,
  ConfirmBookingInput,
  CreateQuotationInput,
  HoldBookingInput,
  QuoteInput,
  SendQuotationInput,
  UpdateBookingInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

export const bookingKeys = {
  all: ['bookings'] as const,
  list: (filters: BookingFilters) => ['bookings', 'list', filters] as const,
  detail: (id: string) => ['bookings', 'detail', id] as const,
  availability: (venueId: string, from: string, to: string) =>
    ['bookings', 'availability', venueId, from, to] as const,
  quotation: (id: string) => ['bookings', 'quotation', id] as const,
};

export const BOOKING_MESSAGES: ErrorMessageOverrides = {
  VERSION_CONFLICT: 'Bookings.errors.changedByOthers',
  SLOT_TAKEN: 'Bookings.errors.slotTaken',
  INVALID_STATE_TRANSITION: 'Bookings.errors.stateNotAllowed',
  ADVANCE_REQUIRED: 'Bookings.errors.advanceRequired',
  LOCAL_RULE: 'Bookings.errors.localRule',
  DISCOUNT_LIMIT: 'Bookings.errors.discountLimit',
};
const FORM = { silent: false, errorMessages: BOOKING_MESSAGES } as const;

export interface BookingFilters {
  status: BookingStatus | '';
  venueId: string;
  customerId: string;
  from: string;
  to: string;
  search: string;
}
export const NO_BOOKING_FILTERS: BookingFilters = {
  status: '',
  venueId: '',
  customerId: '',
  from: '',
  to: '',
  search: '',
};

/** `GET /v1/availability`: spaces x dates x slots of one venue (no prices). */
export function useAvailability(venueId: string, from: string, to: string) {
  return useQuery({
    queryKey: bookingKeys.availability(venueId, from, to),
    queryFn: () =>
      unwrap(api.GET('/v1/availability', { params: { query: { venueId, from, to } } })),
    enabled: venueId !== '',
    refetchInterval: 60_000,
  });
}

/** `GET /v1/bookings`, page after page. */
export function useBookings(filters: BookingFilters) {
  return useInfiniteQuery({
    queryKey: bookingKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/bookings', {
          params: {
            query: {
              limit: 25,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              ...(filters.status === '' ? {} : { status: filters.status }),
              ...(filters.venueId === '' ? {} : { venueId: filters.venueId }),
              ...(filters.customerId === '' ? {} : { customerId: filters.customerId }),
              ...(filters.from === '' ? {} : { from: filters.from }),
              ...(filters.to === '' ? {} : { to: filters.to }),
              ...(filters.search === '' ? {} : { search: filters.search }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useBooking(id: string, enabled = true) {
  return useQuery({
    queryKey: bookingKeys.detail(id),
    queryFn: () => unwrap(api.GET('/v1/bookings/{id}', { params: { path: { id } } })),
    enabled: enabled && id !== '',
    // The worker renders the quotation PDF a moment after a version is saved: look again until the newest one has it.
    refetchInterval: (query) => {
      const latest = query.state.data?.quotations[0];
      return latest && !latest.pdfReady ? 3_000 : false;
    },
  });
}

/** `POST /v1/quotations/preview`: the live breakdown of the builder. Errors are shown inline, not toasted. */
export function useQuotePreview() {
  return useMutation({
    mutationFn: (body: QuoteInput) => unwrap(api.POST('/v1/quotations/preview', { body })),
    meta: { silent: true },
  });
}

function useInvalidateBookings() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: bookingKeys.all });
}

export function useCreateQuotation() {
  const invalidate = useInvalidateBookings();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateQuotationInput) => unwrap(api.POST('/v1/quotations', { body })),
    onSettled: () =>
      Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: ['leads'] })]),
    meta: FORM,
  });
}

export function useSendQuotation() {
  const invalidate = useInvalidateBookings();
  return useMutation({
    mutationFn: ({ id, ...body }: SendQuotationInput & { id: string }) =>
      unwrap(api.POST('/v1/quotations/{id}/send', { params: { path: { id } }, body })),
    onSettled: invalidate,
    meta: FORM,
  });
}

/** A fresh download link (they expire): fetched on click, never cached. */
export function fetchQuotationPdf(id: string) {
  return unwrap(api.GET('/v1/quotations/{id}/pdf', { params: { path: { id } } }));
}

export function fetchQuotationWhatsApp(id: string) {
  return unwrap(api.GET('/v1/quotations/{id}/whatsapp', { params: { path: { id } } }));
}

export function useQuotation(id: string, enabled = true) {
  return useQuery({
    queryKey: bookingKeys.quotation(id),
    queryFn: () => unwrap(api.GET('/v1/quotations/{id}', { params: { path: { id } } })),
    enabled,
    // The PDF is rendered by the worker a moment after the version is saved.
    refetchInterval: (query) => (query.state.data && !query.state.data.pdfReady ? 3_000 : false),
  });
}

export function useUpdateBooking() {
  const invalidate = useInvalidateBookings();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateBookingInput & { id: string }) =>
      unwrap(api.PATCH('/v1/bookings/{id}', { params: { path: { id } }, body })),
    onSettled: invalidate,
    meta: FORM,
  });
}

export type BookingActionInput =
  | { action: 'hold'; id: string; body: HoldBookingInput }
  | { action: 'extend-hold'; id: string; body: { rev: number } }
  | { action: 'rehold'; id: string; body: { rev: number } }
  | { action: 'confirm'; id: string; body: ConfirmBookingInput }
  | { action: 'cancel'; id: string; body: CancelBookingInput }
  | { action: 'restore'; id: string; body: { rev: number } };

/** hold / extend-hold / rehold / confirm / cancel / restore of one booking. A failure is toasted with booking wording. */
export function useBookingAction() {
  const invalidate = useInvalidateBookings();
  return useMutation({
    mutationFn: (input: BookingActionInput) => {
      const params = { path: { id: input.id } };
      switch (input.action) {
        case 'hold':
          return unwrap(api.POST('/v1/bookings/{id}/hold', { params, body: input.body }));
        case 'extend-hold':
          return unwrap(api.POST('/v1/bookings/{id}/extend-hold', { params, body: input.body }));
        case 'rehold':
          return unwrap(api.POST('/v1/bookings/{id}/rehold', { params, body: input.body }));
        case 'confirm':
          return unwrap(api.POST('/v1/bookings/{id}/confirm', { params, body: input.body }));
        case 'cancel':
          return unwrap(api.POST('/v1/bookings/{id}/cancel', { params, body: input.body }));
        case 'restore':
          return unwrap(api.POST('/v1/bookings/{id}/restore', { params, body: input.body }));
      }
    },
    onSettled: invalidate,
    meta: FORM,
  });
}

export function useCancelSession() {
  const invalidate = useInvalidateBookings();
  return useMutation({
    mutationFn: (input: { id: string; sessionId: string; rev: number; reason?: string }) =>
      unwrap(
        api.POST('/v1/bookings/{id}/sessions/{sessionId}/cancel', {
          params: { path: { id: input.id, sessionId: input.sessionId } },
          body: { rev: input.rev, ...(input.reason ? { reason: input.reason } : {}) },
        }),
      ),
    onSettled: invalidate,
    meta: FORM,
  });
}
