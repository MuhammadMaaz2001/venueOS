import type pg from 'pg';

export const pkgDir: string;
export const adminUrl: string;
export function newDbName(): string;
export function urlFor(
  user: 'venueos_migrator' | 'venueos_app' | 'venueos_auth' | 'venueos_jobs',
  database: string,
): string;
export function buildSchemaSql(): string;
export function createTestDatabase(): Promise<{ admin: pg.Client; dbName: string }>;
export function seedAs(
  role: 'venueos_migrator' | 'venueos_app' | 'venueos_auth' | 'venueos_jobs',
  dbName: string,
  context: { tenant?: string; user?: string },
  sql: string,
): Promise<void>;
export function dropTestDatabase(admin: pg.Client | undefined, dbName: string): Promise<void>;
