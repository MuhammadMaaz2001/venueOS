import { createPrismaClient } from './client.js';
import type { DbClientOptions, DbTx, PrismaClient } from './client.js';

export type AuthDbOptions = DbClientOptions;

/**
 * Connection as `venueos_auth`, used by the API's AuthModule ALONE (CLAUDE.md rule 1). It is the only
 * role that can touch `user_credentials`, `auth_sessions`, `auth_tokens`, `invitations` and
 * `login_attempts`, plus manage `users` (explicit RLS policies for it exist). It has no BYPASSRLS,
 * so any other tenant table returns nothing: tenant work still goes through TenantDb.
 *
 * No tenant context is set: auth rows are looked up by token hash / email before a tenant exists.
 */
export class AuthDb {
  /** Plain client for single statements. Use `tx` when several writes must be atomic. */
  readonly client: PrismaClient;

  constructor(options: AuthDbOptions) {
    this.client = createPrismaClient(options);
  }

  tx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn);
  }

  close(): Promise<void> {
    return this.client.$disconnect();
  }
}
