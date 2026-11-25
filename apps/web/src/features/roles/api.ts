'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRoleInput, UpdateRoleInput } from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';
import { staffKeys } from '../staff/api';

export const roleKeys = {
  all: ['roles'] as const,
  list: (withRetired: boolean) => ['roles', 'list', withRetired ? 'all' : 'active'] as const,
};

/**
 * More specific texts than the generic `Errors.<CODE>` for the roles page:
 *  - `FORBIDDEN`: the escalation rule (you cannot give what you do not have);
 *  - `INVALID_STATE_TRANSITION` is the Owner lock-out when saving, "still has members" when retiring and "retired
 *    role" when copying: each call names its own text.
 */
export const SAVE_ROLE_MESSAGES: ErrorMessageOverrides = {
  FORBIDDEN: 'Roles.errors.escalation',
  INVALID_STATE_TRANSITION: 'Roles.errors.ownerLockout',
  DUPLICATE: 'Roles.errors.duplicateName',
  VERSION_CONFLICT: 'Roles.errors.changedByOthers',
};
export const RETIRE_ROLE_MESSAGES: ErrorMessageOverrides = {
  INVALID_STATE_TRANSITION: 'Roles.errors.hasMembers',
  VERSION_CONFLICT: 'Roles.errors.changedByOthers',
};
export const COPY_ROLE_MESSAGES: ErrorMessageOverrides = {
  FORBIDDEN: 'Roles.errors.escalation',
  DUPLICATE: 'Roles.errors.duplicateName',
  INVALID_STATE_TRANSITION: 'Roles.errors.retiredSource',
};

/** `GET /v1/roles`; retired roles only when asked for. */
export function useRoles(withRetired: boolean, enabled = true) {
  return useQuery({
    queryKey: roleKeys.list(withRetired),
    queryFn: () =>
      unwrap(
        api.GET('/v1/roles', { params: { query: { status: withRetired ? 'all' : 'active' } } }),
      ),
    enabled,
  });
}

/** A role changed: the lists of roles, the role pickers of the staff page and the audit log are stale. */
function useRefreshRoles() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: roleKeys.all }),
      queryClient.invalidateQueries({ queryKey: staffKeys.all }),
      queryClient.invalidateQueries({ queryKey: ['audit'] }),
    ]);
}

/** `POST /v1/roles`: a new role as a copy of an existing one. The dialog shows the error inline. */
export function useCreateRole() {
  const refresh = useRefreshRoles();
  return useMutation({
    mutationFn: (body: CreateRoleInput) => unwrap(api.POST('/v1/roles', { body })),
    onSuccess: () => refresh(),
    meta: { silent: true, errorMessages: COPY_ROLE_MESSAGES },
  });
}

/** `PATCH /v1/roles/{id}` with the `rev` the user saw: edit, retire (`active: false`) or restore. */
export function useUpdateRole(errorMessages: ErrorMessageOverrides = SAVE_ROLE_MESSAGES) {
  const refresh = useRefreshRoles();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateRoleInput & { id: string }) =>
      unwrap(api.PATCH('/v1/roles/{id}', { params: { path: { id } }, body })),
    // Success or a conflict: either way the lists must show what the server has now.
    onSettled: () => refresh(),
    meta: { silent: true, errorMessages },
  });
}
