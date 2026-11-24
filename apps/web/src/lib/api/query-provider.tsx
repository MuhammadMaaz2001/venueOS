'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { sessionLostRedirect } from '../safe-next';
import { errorMessageKey } from './error-messages';
import type { ErrorMessageOverrides } from './error-messages';
import { ApiError, isApiError } from './errors';

/**
 * Per query/mutation behaviour of the global error handling, set in `meta`:
 *  - `silent`: the caller shows the error itself (a form field, an inline message): no toast.
 *  - `public`: a 401 is an ANSWER here, not a lost session (login: wrong password; the "am I logged in?" check
 *    of the invitation page), so there is no redirect to the login page. Every other call redirects on 401.
 *  - `errorMessages`: a more specific translation key for some codes (see `error-messages.ts`).
 */
declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { silent?: boolean; public?: boolean; errorMessages?: ErrorMessageOverrides };
    mutationMeta: { silent?: boolean; public?: boolean; errorMessages?: ErrorMessageOverrides };
  }
}

/** Do not retry what a retry cannot fix (4xx), and give the network a couple of chances. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.code === 'NETWORK') return failureCount < 2;
    return false;
  }
  return failureCount < 1;
}

interface Environment {
  router: ReturnType<typeof useRouter>;
  t: ReturnType<typeof useTranslations>;
}

/**
 * The QueryClient lives for the whole tab but its error handlers must always use the CURRENT translator and
 * router (the language changes without a reload). There is one provider per tab, so one holder is enough.
 */
const environment: { current: Environment | null } = { current: null };

/** Errors, 401 handling and the QueryClient of the app. One per browser tab. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const t = useTranslations();

  useEffect(() => {
    environment.current = { router, t };
  }, [router, t]);

  // Tells automated browsers (the Playwright tests) that the page is interactive: a form filled before React
  // took over would otherwise lose what was typed.
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);

  const [client] = useState(() => {
    const handle = (
      error: unknown,
      meta:
        { silent?: boolean; public?: boolean; errorMessages?: ErrorMessageOverrides } | undefined,
      queryClient: QueryClient,
    ): void => {
      const env = environment.current;
      if (!env) return;
      const { router: currentRouter, t: translate } = env;
      const apiError =
        error instanceof ApiError ? error : new ApiError('INTERNAL', 0, 'Unexpected error');

      if (apiError.isSessionProblem && !meta?.public) {
        // The cookie is gone or expired: forget everything that was loaded, go to the login page once.
        queryClient.clear();
        currentRouter.replace(sessionLostRedirect(window.location, apiError.code));
        return;
      }
      if (meta?.silent) return;
      toast.error(translate(errorMessageKey(apiError, meta?.errorMessages)), {
        // Quote it in a bug report; the id is not secret.
        description: apiError.requestId
          ? `${translate('Errors.requestId')}: ${apiError.requestId}`
          : undefined,
        id: apiError.code, // one toast per code at a time
      });
    };

    const queryClient: QueryClient = new QueryClient({
      queryCache: new QueryCache({
        onError: (error, query) => handle(error, query.meta, queryClient),
      }),
      mutationCache: new MutationCache({
        onError: (error, _variables, _context, mutation) =>
          handle(error, mutation.meta, queryClient),
      }),
      defaultOptions: {
        queries: { retry: shouldRetry, staleTime: 30_000, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    return queryClient;
  });

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
