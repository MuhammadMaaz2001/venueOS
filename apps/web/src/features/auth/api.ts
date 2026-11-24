'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptInvitationNewUserInput,
  LoginInput,
  ResetPasswordInput,
  SignupInput,
} from '@venueos/shared';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { meKeys } from '../me/api';

// Every form of this module shows its own errors (field messages, the "wrong password" line), so its mutations
// are `silent` (no toast) and `public` (a 401 is an answer, not a lost session).

/** `POST /v1/auth/signup`: always the same 202, whether or not the address already has an account. */
export function useSignup() {
  return useMutation({
    mutationFn: (body: SignupInput) => unwrap(api.POST('/v1/auth/signup', { body })),
    meta: { silent: true, public: true },
  });
}

/** `POST /v1/auth/login`: sets the cookie; the body says who and where. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginInput) => unwrap(api.POST('/v1/auth/login', { body })),
    onSuccess: () => {
      // Nothing of a previous session may survive into this one.
      queryClient.clear();
    },
    meta: { silent: true, public: true },
  });
}

/** `POST /v1/auth/resend-verification`: generic 202. */
export function useResendVerification() {
  return useMutation({
    mutationFn: (email: string) =>
      unwrap(api.POST('/v1/auth/resend-verification', { body: { email } })),
    meta: { silent: true, public: true },
  });
}

/** `POST /v1/auth/password/forgot`: generic 202. */
export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) =>
      unwrap(api.POST('/v1/auth/password/forgot', { body: { email } })),
    meta: { silent: true, public: true },
  });
}

/** `POST /v1/auth/verify-email` (204). A plain function: the token page sends it once (`useTokenAction`). */
export function verifyEmailRequest(token: string): Promise<undefined> {
  return unwrap(api.POST('/v1/auth/verify-email', { body: { token } }));
}

/** `POST /v1/auth/password/reset` (204): ends every session of the user. */
export function resetPasswordRequest(input: ResetPasswordInput): Promise<undefined> {
  return unwrap(api.POST('/v1/auth/password/reset', { body: input }));
}

/** `POST /v1/auth/invitations/accept` for a NEW user (an existing address answers 409). */
export function acceptInvitationRequest(
  input: AcceptInvitationNewUserInput,
): Promise<{ tenantId: string }> {
  return unwrap(api.POST('/v1/auth/invitations/accept', { body: input }));
}

/** Log out here (`everywhere = false`) or on every device. The cache is dropped either way. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (everywhere: boolean) =>
      unwrap(everywhere ? api.POST('/v1/auth/logout-all') : api.POST('/v1/auth/logout')),
    onSettled: () => {
      // Even when the call failed (the session was already gone) the user leaves.
      queryClient.clear();
      queryClient.removeQueries({ queryKey: meKeys.me });
    },
    meta: { silent: true, public: true },
  });
}
