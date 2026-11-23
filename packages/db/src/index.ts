// Public surface of @venueos/db. Feature code gets TenantDb (tenant data) or AuthDb (AuthModule only);
// the generated PrismaClient is deliberately NOT exported (CLAUDE.md rule 1).

export { TenantDb } from './tenant-db.js';
export type { TenantContext, TenantDbOptions, TenantTxFn } from './tenant-db.js';

export { AuthDb } from './auth-db.js';
export type { AuthDbOptions } from './auth-db.js';

export type { DbTx, DbClientOptions } from './client.js';

export { pgBossDb } from './pgboss-adapter.js';
export type { PgBossDb } from './pgboss-adapter.js';

export { JobQueue, PGBOSS_SCHEMA, enqueueEmail } from './jobs/job-queue.js';
export type {
  EnqueuedEmail,
  EnqueueableJob,
  JobPayloads,
  JobQueueOptions,
  RetryPolicy,
} from './jobs/job-queue.js';
export { expectedPgBossSchemaVersion } from './jobs/schema-version.js';

// Enums (value + type) and row/input types for the schema's models. `Prisma` is the type-only
// namespace (Prisma.Decimal is a value and is imported from 'decimal.js' where money is computed).
export * from './generated/prisma/enums.js';
export type * from './generated/prisma/client.js';
