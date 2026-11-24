'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export const meKeys = {
  me: ['me'] as const,
  tenants: ['me', 'tenants'] as const,
};

/** Who am I, and what may I do in the active workspace (`GET /v1/me`). */
export function useMe(options: { anonymousOk?: boolean } = {}) {
  return useQuery({
    queryKey: meKeys.me,
    queryFn: () => unwrap(api.GET('/v1/me')),
    // `anonymousOk`: a pre-login page asks "am I logged in?"; a 401 is the answer "no", not an error.
    meta: options.anonymousOk ? { silent: true, public: true } : {},
  });
}

/** The workspaces I am an active member of (`GET /v1/me/tenants`), with currency and time zone. */
export function useTenants() {
  return useQuery({
    queryKey: meKeys.tenants,
    queryFn: () => unwrap(api.GET('/v1/me/tenants')),
  });
}

/**
 * Work in another workspace (`POST /v1/me/switch-tenant`, which rotates the session cookie). Everything that was
 * loaded belonged to the old workspace, so the whole cache is dropped and `me` is refilled from the answer.
 */
export function useSwitchTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      unwrap(api.POST('/v1/me/switch-tenant', { body: { tenantId } })),
    onSuccess: (me) => {
      queryClient.clear();
      queryClient.setQueryData(meKeys.me, me);
    },
  });
}

/** Accept a staff invitation with the account I am logged in with (`POST /v1/me/invitations/accept`). */
export function useAcceptInvitationAsMember() {
  return useMutation({
    mutationFn: (token: string) =>
      unwrap(api.POST('/v1/me/invitations/accept', { body: { token } })),
    // The caller shows the error inline (wrong account, expired invitation).
    meta: { silent: true },
  });
}
