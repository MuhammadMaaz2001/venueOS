import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContextProvider } from '../../common/access/auth-context.provider';
import type { AuthContext } from '../../common/access/access-context';

// TEST-ONLY. This stub stands in for the P0-4 session lookup so guard and endpoint tests can say who
// is calling. It lives in test files and is installed only by `createTestApp` (overrideProvider);
// `no-test-auth.spec.ts` proves the production AppModule never contains it and that no header can
// authenticate a real request.

export const TEST_AUTH_HEADER = 'x-test-auth';

@Injectable()
export class TestAuthContextProvider extends AuthContextProvider {
  resolve(req: Request): AuthContext | undefined {
    const raw = req.header(TEST_AUTH_HEADER);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AuthContext;
    } catch {
      return undefined;
    }
  }
}

/** Header that makes `userId` the caller, working in `activeTenantId` (null = no tenant chosen). */
export function authHeader(
  userId: string,
  activeTenantId: string | null,
  sessionId = 'sess_test',
): Record<string, string> {
  const auth: AuthContext = { userId, sessionId, activeTenantId };
  return { [TEST_AUTH_HEADER]: JSON.stringify(auth) };
}
