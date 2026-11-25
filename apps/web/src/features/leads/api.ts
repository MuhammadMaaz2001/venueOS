'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateLeadInput, LeadSource, LeadStage, UpdateLeadInput } from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

/** The filters of the board and the list. Empty text = no filter. */
export interface LeadFilters {
  venueId: string;
  /** A membership id, or `unassigned`, or ''. */
  assignee: string;
  source: LeadSource | '';
  followUp: 'overdue' | 'today' | '';
  search: string;
}
export const NO_FILTERS: LeadFilters = {
  venueId: '',
  assignee: '',
  source: '',
  followUp: '',
  search: '',
};

export const leadKeys = {
  all: ['leads'] as const,
  list: (filters: LeadFilters, stage: LeadStage | '') => ['leads', 'list', filters, stage] as const,
  detail: (id: string) => ['leads', 'detail', id] as const,
  activity: (id: string) => ['leads', 'activity', id] as const,
  assignees: (venueId: string) => ['leads', 'assignees', venueId] as const,
  followUps: (assignee: string) => ['leads', 'follow-ups', assignee] as const,
};

export const LEAD_MESSAGES: ErrorMessageOverrides = {
  VERSION_CONFLICT: 'Leads.errors.changedByOthers',
  INVALID_STATE_TRANSITION: 'Leads.errors.stageNotAllowed',
};
const FORM = { silent: false, errorMessages: LEAD_MESSAGES } as const;

/** `GET /v1/leads`, page after page. The board asks once per stage (`stage`), the list view once for all. */
export function useLeads(options: {
  filters: LeadFilters;
  stage?: LeadStage | undefined;
  limit?: number;
  enabled?: boolean;
}) {
  const { filters, stage } = options;
  return useInfiniteQuery({
    queryKey: leadKeys.list(filters, stage ?? ''),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/leads', {
          params: {
            query: {
              limit: options.limit ?? 25,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              ...(stage === undefined ? {} : { stage }),
              ...(filters.venueId === '' ? {} : { venueId: filters.venueId }),
              ...(filters.assignee === 'unassigned'
                ? { unassigned: 'true' as const }
                : filters.assignee === ''
                  ? {}
                  : { assigneeId: filters.assignee }),
              ...(filters.source === '' ? {} : { source: filters.source }),
              ...(filters.followUp === '' ? {} : { followUp: filters.followUp }),
              ...(filters.search === '' ? {} : { search: filters.search }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

export function useLead(id: string) {
  return useQuery({
    queryKey: leadKeys.detail(id),
    queryFn: () => unwrap(api.GET('/v1/leads/{id}', { params: { path: { id } } })),
  });
}

export function useLeadActivity(id: string) {
  return useQuery({
    queryKey: leadKeys.activity(id),
    queryFn: () => unwrap(api.GET('/v1/leads/{id}/activity', { params: { path: { id } } })),
  });
}

/** `GET /v1/leads/assignees`: who a lead of `venueId` (any venue when empty) can be given to. */
export function useLeadAssignees(venueId: string, enabled = true) {
  return useQuery({
    queryKey: leadKeys.assignees(venueId),
    queryFn: () =>
      unwrap(
        api.GET('/v1/leads/assignees', {
          params: { query: venueId === '' ? {} : { venueId } },
        }),
      ),
    enabled,
  });
}

/** `GET /v1/leads/follow-ups`: the dashboard card. */
export function useLeadFollowUps(assignee: 'me' | 'any', enabled = true) {
  return useQuery({
    queryKey: leadKeys.followUps(assignee),
    queryFn: () =>
      unwrap(api.GET('/v1/leads/follow-ups', { params: { query: { assignee, limit: 5 } } })),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useCreateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLeadInput) => unwrap(api.POST('/v1/leads', { body })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: leadKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
      ]),
    meta: FORM,
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateLeadInput & { id: string }) =>
      unwrap(api.PATCH('/v1/leads/{id}', { params: { path: { id } }, body })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: leadKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
      ]),
    meta: FORM,
  });
}
