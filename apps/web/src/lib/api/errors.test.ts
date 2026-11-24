import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFrom, isApiError, unwrap } from './errors';

const body = (code: string, details?: unknown) => ({
  error: { code, message: 'English text', details, requestId: 'req_1' },
});

describe('apiErrorFrom', () => {
  it('keeps the code, status, details and request id of the API error format', () => {
    const error = apiErrorFrom(body('FORBIDDEN', { reason: 'EMAIL_NOT_VERIFIED' }), 403);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403, requestId: 'req_1' });
    expect(error.reason).toBe('EMAIL_NOT_VERIFIED');
  });

  it('exposes the field issues of a VALIDATION_ERROR and nothing for other codes', () => {
    const issues = [{ path: 'password', code: 'too_small', message: 'x' }];
    expect(apiErrorFrom(body('VALIDATION_ERROR', issues), 400).fieldIssues).toEqual(issues);
    expect(apiErrorFrom(body('FORBIDDEN', issues), 403).fieldIssues).toEqual([]);
  });

  it('turns an unknown shape (a proxy error page) into INTERNAL, never into its text', () => {
    const error = apiErrorFrom('<html>Bad gateway</html>', 502);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).not.toContain('Bad gateway');
  });

  it('knows a lost session', () => {
    expect(apiErrorFrom(body('UNAUTHENTICATED'), 401).isSessionProblem).toBe(true);
    expect(apiErrorFrom(body('SESSION_EXPIRED'), 401).isSessionProblem).toBe(true);
    expect(apiErrorFrom(body('FORBIDDEN'), 403).isSessionProblem).toBe(false);
  });
});

describe('unwrap', () => {
  const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });

  it('returns the data of a success', async () => {
    await expect(unwrap(Promise.resolve(ok({ a: 1 })))).resolves.toEqual({ a: 1 });
  });

  it('throws an ApiError for an error body', async () => {
    const failed = Promise.resolve({
      error: body('NOT_FOUND'),
      response: new Response(null, { status: 404 }),
    });
    await expect(unwrap(failed)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('turns a request that never arrived into NETWORK', async () => {
    const error = await unwrap(Promise.reject(new TypeError('Failed to fetch'))).catch(
      (cause: unknown) => cause,
    );
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'NETWORK', status: 0 });
  });
});
