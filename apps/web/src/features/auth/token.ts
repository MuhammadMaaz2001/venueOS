'use client';

import { OneTimeTokenSchema } from '@venueos/shared';
import { useEffect } from 'react';

/** A token as it appears in an emailed link, or null when the link is missing or malformed. */
export function validToken(raw: string | null | undefined): string | null {
  const parsed = OneTimeTokenSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Remove `?token=...` from the address bar as soon as the page has it (docs/09, "Handoff from P0-4"): the
 * secret must not stay in the browser history, a bookmark or a copied URL. `Referrer-Policy` is already strict.
 */
export function useStripTokenFromUrl(): void {
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);
}

/** Key under which an invitation token waits while the user logs in (this tab only, never persisted). */
export const PENDING_INVITE_KEY = 'vos.pendingInvite';

export function rememberPendingInvite(token: string): void {
  try {
    window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
  } catch {
    /* storage can be blocked; the user then opens the link from the email again */
  }
}

/** The token waiting for the user's login, if any (it stays until `clearPendingInvite`). */
export function peekPendingInvite(): string | null {
  try {
    return validToken(window.sessionStorage.getItem(PENDING_INVITE_KEY));
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* nothing to clear */
  }
}
