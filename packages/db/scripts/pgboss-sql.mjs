#!/usr/bin/env node
// Prints the SQL pg-boss needs, for a Prisma migration (docs/08-deployment-and-ops.md "pg-boss").
//
//   node scripts/pgboss-sql.mjs construct          the full schema (what the first migration contains)
//   node scripts/pgboss-sql.mjs migrate <from>     the upgrade from schema version <from> to the
//                                                  version of the installed pg-boss
//   node scripts/pgboss-sql.mjs version            the schema version of the installed pg-boss
//
// pg-boss is pinned to an exact version in package.json. Upgrading it means: bump the pin, run
// `migrate <current version>`, put the output into a NEW migration (never edit an applied one),
// run the tests (pgboss-schema.test.ts compares the installed library's version with the database).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getConstructionPlans, getMigrationPlans } = require('pg-boss');
const SCHEMA = 'pgboss';

const [mode, from] = process.argv.slice(2);
const construction = getConstructionPlans(SCHEMA);

if (mode === 'construct') {
  process.stdout.write(construction + '\n');
} else if (mode === 'migrate' && /^\d+$/.test(from ?? '')) {
  process.stdout.write(getMigrationPlans(SCHEMA, Number(from)) + '\n');
} else if (mode === 'version') {
  const m = /INSERT INTO pgboss\.version\(version\) VALUES \('(\d+)'\)/.exec(construction);
  process.stdout.write(`${m?.[1] ?? 'unknown'}\n`);
} else {
  console.error('usage: pgboss-sql.mjs construct | migrate <fromVersion> | version');
  process.exit(2);
}
