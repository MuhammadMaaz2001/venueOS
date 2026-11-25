'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

/** What the filters of the audit page send. Empty values are left out of the request. */
export interface AuditFilters {
  entityType?: string;
  action?: string;
  actorUserId?: string;
  /** `YYYY-MM-DD`: whole days of the workspace time zone. */
  from?: string;
  to?: string;
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (filters: AuditFilters) => ['audit', 'list', filters] as const,
  one: (id: string) => ['audit', 'one', id] as const,
};

const clean = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/** `GET /v1/audit-logs`, newest first, a page at a time (`fetchNextPage` follows the cursor). */
export function useAuditLogs(filters: AuditFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/audit-logs', {
          params: {
            query: {
              limit: 25,
              ...(pageParam ? { cursor: pageParam } : {}),
              ...(clean(filters.entityType) ? { entityType: filters.entityType } : {}),
              ...(clean(filters.action) ? { action: filters.action } : {}),
              ...(clean(filters.actorUserId) ? { actorUserId: filters.actorUserId } : {}),
              ...(clean(filters.from) ? { from: filters.from } : {}),
              ...(clean(filters.to) ? { to: filters.to } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

/** `GET /v1/audit-logs/{id}`: one entry with its before and after. */
export function useAuditLog(id: string | null) {
  return useQuery({
    queryKey: auditKeys.one(id ?? ''),
    queryFn: () =>
      unwrap(api.GET('/v1/audit-logs/{id}', { params: { path: { id: id as string } } })),
    enabled: id !== null,
  });
}
