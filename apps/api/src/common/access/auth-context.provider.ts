import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from './access-context';

/**
 * The slot AuthGuard asks "who is calling?". P0-4 replaces the default with the real implementation
 * (session cookie -> `auth_sessions` through AuthDb). Return undefined when the request carries no valid
 * credentials; AuthGuard turns that into 401.
 *
 * It is an abstract class so it can be the injection token. Tests override it with a stub that lives in
 * test files only (`__tests__/helpers/test-auth.ts`): nothing in the application ever reads a header
 * to decide who a caller is.
 */
export abstract class AuthContextProvider {
  abstract resolve(req: Request): Promise<AuthContext | undefined> | AuthContext | undefined;
}

/** P0-5 default: nobody can authenticate yet, so every non-public route answers 401 (fail closed). */
@Injectable()
export class NoAuthContextProvider extends AuthContextProvider {
  resolve(): undefined {
    return undefined;
  }
}
