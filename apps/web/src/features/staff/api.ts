'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateInvitationInput, UpdateStaffInput } from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';

export const staffKeys = {
  all: ['staff'] as const,
  members: ['staff', 'members'] as const,
  invitations: ['staff', 'invitations'] as const,
  roles: ['staff', 'assignable-roles'] as const,
};

/**
 * More specific texts than the generic `Errors.<CODE>` for the staff page:
 *  - `INVALID_STATE_TRANSITION` is the last-Owner rule when changing a member and "already accepted" when
 *    revoking an invitation;
 *  - `FORBIDDEN` here means "that member has more access than you";
 *  - `DUPLICATE` is "already a member" / "already invited".
 */
export const UPDATE_MEMBER_MESSAGES: ErrorMessageOverrides = {
  INVALID_STATE_TRANSITION: 'Staff.errors.lastOwner',
  FORBIDDEN: 'Staff.errors.cannotManage',
  VERSION_CONFLICT: 'Staff.errors.changedByOthers',
};
export const INVITE_MESSAGES: ErrorMessageOverrides = {
  DUPLICATE: 'Staff.errors.duplicateInvite',
  FORBIDDEN: 'Staff.errors.cannotInvite',
  PLAN_LIMIT_REACHED: 'Staff.errors.planLimit',
};
export const REVOKE_MESSAGES: ErrorMessageOverrides = {
  INVALID_STATE_TRANSITION: 'Staff.errors.alreadyAccepted',
};

/** `GET /v1/staff`. */
export function useStaff() {
  return useQuery({
    queryKey: staffKeys.members,
    queryFn: () => unwrap(api.GET('/v1/staff')),
  });
}

/** `GET /v1/staff/invitations`. */
export function useInvitations() {
  return useQuery({
    queryKey: staffKeys.invitations,
    queryFn: () => unwrap(api.GET('/v1/staff/invitations')),
  });
}

/** `GET /v1/staff/assignable-roles`: the roles the caller may give to someone. */
export function useAssignableRoles(enabled = true) {
  return useQuery({
    queryKey: staffKeys.roles,
    queryFn: () => unwrap(api.GET('/v1/staff/assignable-roles')),
    enabled,
  });
}

/** `POST /v1/staff/invitations`. */
export function useInviteStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInvitationInput) =>
      unwrap(api.POST('/v1/staff/invitations', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: staffKeys.invitations }),
    meta: { errorMessages: INVITE_MESSAGES },
  });
}

/** `DELETE /v1/staff/invitations/{id}` (204). */
export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/staff/invitations/{id}', { params: { path: { id } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: staffKeys.invitations }),
    meta: { errorMessages: REVOKE_MESSAGES },
  });
}

/** `PATCH /v1/staff/{membershipId}`; `rev` is the version the user saw. A conflict reloads the list. */
export function useUpdateStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ membershipId, ...body }: UpdateStaffInput & { membershipId: string }) =>
      unwrap(
        api.PATCH('/v1/staff/{membershipId}', {
          params: { path: { membershipId } },
          body,
        }),
      ),
    // Success or a conflict: either way the list must show what the server has now.
    onSettled: () => queryClient.invalidateQueries({ queryKey: staffKeys.members }),
    // The edit dialog shows the error inline (the last-Owner rule must be impossible to miss).
    meta: { silent: true, errorMessages: UPDATE_MEMBER_MESSAGES },
  });
}
