// The ONLY file allowed to use $queryRawUnsafe (see eslint.config.mjs and docs/04-security.md).
//
// pg-boss builds its own SQL text (table names, upserts, locking) and hands it to a `db` object:
//     boss.send('email.send', payload, { db: pgBossDb(tx) })
// Running that SQL on the Prisma transaction client puts the job INSERT in the same transaction as
// the business change, so a rolled-back booking never sends an email (docs/02-system-design.md).
//
// Why raw/unsafe is acceptable here: the SQL text is produced by the pg-boss library, never by
// request data, and every value still travels as a bound parameter ($1, $2, ...). Do NOT use this
// adapter for anything that interpolates user input into the text.
//
// Limits: one statement per call (pg-boss's `send`/`insert` is single-statement; the multi-statement
// maintenance calls use pg-boss's own pool, not this adapter). Column types follow Prisma's raw
// mapping (bigint arrives as `bigint`).

import type { DbTx } from './client.js';

/** The structural interface pg-boss expects for its `db` option. */
export interface PgBossDb {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Adapt a TenantDb/AuthDb transaction client for pg-boss. */
export function pgBossDb(tx: DbTx): PgBossDb {
  return {
    async executeSql(text, values = []) {
      const rows = await tx.$queryRawUnsafe<unknown[]>(text, ...values);
      return { rows };
    },
  };
}
