import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import type { Prisma } from './generated/prisma/client.js';

/** Interactive-transaction client handed to feature code. Never a PrismaClient. */
export type DbTx = Prisma.TransactionClient;

/** Options shared by every database client built in this package. */
export interface DbClientOptions {
  /** Postgres URL of the role this client represents (venueos_app, venueos_auth, ...). */
  connectionString: string;
  /** Maximum pooled connections (default: the pg default, 10). */
  poolMax?: number;
}

/** Internal factory. The only place that instantiates PrismaClient for the runtime roles. */
export function createPrismaClient({ connectionString, poolMax }: DbClientOptions): PrismaClient {
  if (!connectionString) {
    throw new Error('A database connection string is required');
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...(poolMax !== undefined ? { max: poolMax } : {}) }),
  });
}

export type { PrismaClient };
