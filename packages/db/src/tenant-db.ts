import { createPrismaClient } from './client.js';
import type { DbClientOptions, DbTx, PrismaClient } from './client.js';

/**
 * Who is acting. `tenantId` comes from the session (staff) or from resolve_tenant(host)
 * (public pages), never from a request body (CLAUDE.md rule 1).
 */
export interface TenantContext {
  tenantId: string;
  /** The acting user. Omit for system work (jobs). */
  userId?: string | null;
}

export interface TenantDbOptions extends DbClientOptions {
  /**
   * Supplies the ambient context (request-scoped CLS in the API, the job payload in the worker)
   * so feature code can call `tx(fn)` without passing it around. Optional: `tx(ctx, fn)` always works.
   */
  getContext?: () => Partial<TenantContext> | undefined;
  /** Interactive transaction limits in ms (Prisma defaults are 2000 / 5000). */
  transaction?: { maxWait?: number; timeout?: number };
}

export type TenantTxFn<T> = (tx: DbTx) => Promise<T>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertId(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`TenantDb: ${name} is missing or malformed`);
  }
}

/**
 * The only door to tenant data. Every call runs in ONE transaction that first sets
 * `app.tenant_id` / `app.user_id` with `set_config(..., true)` (transaction-local), so Row Level
 * Security applies to every following statement and the setting disappears at COMMIT/ROLLBACK:
 * a pooled connection never carries a tenant into the next request. This is proven against
 * Postgres by tests/gate-set-config.test.ts.
 *
 * Runs as `venueos_app` (no BYPASSRLS, no access to the auth tables).
 */
export class TenantDb {
  private readonly prisma: PrismaClient;
  private readonly getContext: (() => Partial<TenantContext> | undefined) | undefined;
  private readonly txOptions: { maxWait: number; timeout: number };

  constructor(options: TenantDbOptions) {
    this.prisma = createPrismaClient(options);
    this.getContext = options.getContext;
    this.txOptions = {
      maxWait: options.transaction?.maxWait ?? 5_000,
      timeout: options.transaction?.timeout ?? 10_000,
    };
  }

  /**
   * Run `fn` inside a transaction scoped to a tenant (and user). With one argument the context
   * comes from `getContext`.
   */
  tx<T>(fn: TenantTxFn<T>): Promise<T>;
  tx<T>(ctx: TenantContext, fn: TenantTxFn<T>): Promise<T>;
  tx<T>(a: TenantContext | TenantTxFn<T>, b?: TenantTxFn<T>): Promise<T> {
    const [ctx, fn] = typeof a === 'function' ? [this.getContext?.(), a] : [a, b];
    return this.run(ctx?.tenantId, ctx?.userId ?? '', fn, 'tx');
  }

  /**
   * Pre-tenant context: only `app.user_id` is set (login, tenant switcher, signup step 3). RLS then
   * shows the user their own memberships and tenants, and nothing else.
   */
  asUser<T>(fn: TenantTxFn<T>): Promise<T>;
  asUser<T>(userId: string, fn: TenantTxFn<T>): Promise<T>;
  asUser<T>(a: string | TenantTxFn<T>, b?: TenantTxFn<T>): Promise<T> {
    const [userId, fn] = typeof a === 'function' ? [this.getContext?.()?.userId, a] : [a, b];
    return this.run('', userId, fn, 'asUser');
  }

  /** Disconnect the pool (Nest `onModuleDestroy`, test teardown). */
  close(): Promise<void> {
    return this.prisma.$disconnect();
  }

  // async: bad input surfaces as a rejected promise, never as a synchronous throw.
  private async run<T>(
    tenantId: string | undefined,
    userId: string | null | undefined,
    fn: TenantTxFn<T> | undefined,
    caller: 'tx' | 'asUser',
  ): Promise<T> {
    if (!fn) throw new Error(`TenantDb.${caller}: callback is required`);
    // tx() needs a tenant; asUser() passes '' for it and needs a user instead.
    if (caller === 'tx') assertId('tenantId', tenantId);
    if (caller === 'asUser' || (userId ?? '') !== '') assertId('userId', userId);
    const tenant = tenantId ?? '';
    const user = userId ?? '';
    return this.prisma.$transaction(async (tx) => {
      // One statement; '' means "not set" (the SQL helpers app_current_* map '' to NULL).
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true), set_config('app.user_id', ${user}, true)`;
      return fn(tx);
    }, this.txOptions);
  }
}
