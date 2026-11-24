import { useEffect, useState } from 'react';

/**
 * "Send this exactly once" for one-time tokens (verify email, accept invite, reset password).
 *
 * Why not a `useRef` or a component-level flag: React StrictMode (development) mounts every component, unmounts
 * it and mounts it again, running each effect twice; a second POST of a single-use token would fail with
 * "already used" and show the user an error for something that worked. A remount also resets refs. So the
 * in-flight promise lives in a module-level map keyed by the call and the token, and every caller with the same
 * key gets the same promise.
 */
const submissions = new Map<string, Promise<unknown>>();

export function submissionKey(purpose: string, token: string): string {
  return `${purpose}:${token}`;
}

/** Run `run` once per `key`; later callers get the first call's promise (success or failure alike). */
export function submitOnce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = submissions.get(key);
  if (existing) return existing as Promise<T>;
  const started = run();
  submissions.set(key, started);
  return started;
}

/** Allow the next `submitOnce(key)` to run again: only after a failure that did NOT use the token up. */
export function forgetSubmission(key: string): void {
  submissions.delete(key);
}

/** Test helper: drop every remembered call. */
export function resetSubmissions(): void {
  submissions.clear();
}

export type TokenActionState<T> =
  { status: 'pending' } | { status: 'success'; value: T } | { status: 'error'; error: unknown };

/**
 * Send a token to the API as soon as the page shows, once, and expose the outcome. Safe under StrictMode's
 * double effects and remounts (see `submitOnce`). There is no automatic retry: a single-use token that failed
 * stays failed; the user asks for a new email.
 */
export function useTokenAction<T>(
  purpose: string,
  token: string | null,
  run: (token: string) => Promise<T>,
): TokenActionState<T> {
  const [state, setState] = useState<TokenActionState<T>>({ status: 'pending' });

  useEffect(() => {
    if (!token) return;
    let active = true;
    submitOnce(submissionKey(purpose, token), () => run(token)).then(
      (value) => {
        if (active) setState({ status: 'success', value });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', error });
      },
    );
    return () => {
      active = false;
    };
    // `run` must be a stable (module-level) function, so this runs once per (purpose, token).
  }, [purpose, token, run]);

  return state;
}
