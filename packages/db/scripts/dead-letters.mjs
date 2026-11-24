#!/usr/bin/env node
// Dead-letter tooling for the job queue (docs/08-deployment-and-ops.md, "Dead letters").
//
//   node scripts/dead-letters.mjs list [--queue <name>]
//   node scripts/dead-letters.mjs show <jobId>
//   node scripts/dead-letters.mjs redrive <jobId>            dry run: says what would happen
//   node scripts/dead-letters.mjs redrive --queue <name>     every dead letter of one queue
//   node scripts/dead-letters.mjs discard <jobId>
//   node scripts/dead-letters.mjs ... --apply                actually change something
//
// Runs as the migrator (MIGRATE_DATABASE_URL), the only role that may touch the queue's rows besides the
// worker: this is the "reviewed ops script run as the migrator" of docs/08. It never prints the job's payload
// beyond what is there by design (identifiers only: pgboss.job has no Row Level Security, docs/04 section 4),
// and never prints connection strings.
//
// `redrive` sends a NEW job (same payload) to the original queue, with the queue's own retry policy, then removes
// the dead one. Fix the cause first: the redriven job fails the same way if nothing changed. `discard` removes a
// dead letter for good (for example one whose entity no longer exists); keep the reason in the ops log.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { PgBoss } = require('pg-boss');

const SCHEMA = 'pgboss';
const DEAD_SUFFIX = '.dead';

export class UsageError extends Error {}

/** Parse argv into { command, jobId, queue, apply }. */
export function parseArgs(argv) {
  const args = [...argv];
  const apply = args.includes('--apply');
  const rest = args.filter((a) => a !== '--apply');
  const queueAt = rest.indexOf('--queue');
  let queue;
  if (queueAt !== -1) {
    queue = rest[queueAt + 1];
    rest.splice(queueAt, 2);
  }
  const [command, jobId, ...extra] = rest;
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);
  if (queue !== undefined && !queue.endsWith(DEAD_SUFFIX)) {
    throw new UsageError(`--queue must be a dead-letter queue (name ending in ${DEAD_SUFFIX})`);
  }
  return { command, jobId, queue, apply };
}

async function listRows(client, { jobId, queue }) {
  // pg-boss copies a failed job into `<queue>.dead` with its payload only: the failure code and the retry
  // count stay on the job that failed. That job is found by queue, payload and the moment it failed.
  const { rows } = await client.query(
    `SELECT d.id, d.name, d.state, d.created_on, d.data,
            o.id AS original_id, o.output, o.retry_count
       FROM pgboss.job d
       LEFT JOIN LATERAL (
              SELECT j.id, j.output, j.retry_count
                FROM pgboss.job j
               WHERE j.name = left(d.name, length(d.name) - 5)
                 AND j.dead_letter = d.name
                 AND j.state = 'failed'
                 AND j.data = d.data
                 AND j.completed_on BETWEEN d.created_on - interval '10 seconds' AND d.created_on + interval '10 seconds'
               ORDER BY abs(extract(epoch FROM j.completed_on - d.created_on))
               LIMIT 1) o ON true
      WHERE d.name LIKE '%.dead'
        AND ($1::text IS NULL OR d.name = $1)
        AND ($2::text IS NULL OR d.id::text = $2)
      ORDER BY d.created_on, d.id`,
    [queue ?? null, jobId ?? null],
  );
  return rows;
}

const originalQueue = (deadName) => deadName.slice(0, -DEAD_SUFFIX.length);
const ageOf = (row) =>
  Math.max(0, Math.round((Date.now() - new Date(row.created_on).getTime()) / 1000));
const codeOf = (row) => (row.output && typeof row.output.code === 'string' ? row.output.code : '-');

/**
 * Run one command against `client` (a connected pg client as the migrator). Returns the lines to print.
 * Exported for tests; the CLI below prints them.
 */
export async function run(client, { command, jobId, queue, apply }, pgBossFactory = defaultBoss) {
  switch (command) {
    case 'list': {
      const rows = await listRows(client, { queue });
      if (rows.length === 0) return ['no dead letters'];
      return [
        'id\tqueue\tage_s\tcode\tretries',
        ...rows.map((r) => `${r.id}\t${r.name}\t${ageOf(r)}\t${codeOf(r)}\t${r.retry_count}`),
      ];
    }
    case 'show': {
      if (!jobId) throw new UsageError('show needs a job id');
      const [row] = await listRows(client, { jobId });
      if (!row) return [`no dead letter with id ${jobId}`];
      return [
        JSON.stringify(
          {
            id: row.id,
            queue: row.name,
            originalQueue: originalQueue(row.name),
            failedJobId: row.original_id,
            ageSeconds: ageOf(row),
            retries: row.retry_count,
            failure: row.output,
            data: row.data,
          },
          null,
          2,
        ),
      ];
    }
    case 'redrive':
    case 'discard': {
      if (!jobId && !queue) throw new UsageError(`${command} needs a job id or --queue <name>`);
      if (jobId && queue) throw new UsageError(`${command} takes a job id or --queue, not both`);
      const rows = await listRows(client, { jobId, queue });
      if (rows.length === 0) return ['no matching dead letters'];
      const lines = [];
      const boss = command === 'redrive' && apply ? pgBossFactory(client) : undefined;
      for (const row of rows) {
        const target = originalQueue(row.name);
        const verb = command === 'redrive' ? `redrive to ${target}` : 'discard';
        if (!apply) {
          lines.push(`would ${verb}: ${row.id} (${codeOf(row)})`);
          continue;
        }
        if (boss) {
          // A fresh singleton key per redrive, so it cannot collide with a job that is still queued.
          const newId = await boss.send(target, row.data ?? {}, {
            singletonKey: `redrive-${row.id}`,
          });
          if (!newId) {
            lines.push(`skipped ${row.id}: a redriven job is already queued`);
            continue;
          }
          lines.push(`redriven ${row.id} -> ${newId} (${target})`);
        } else {
          lines.push(`discarded ${row.id}`);
        }
        await client.query('DELETE FROM pgboss.job WHERE id = $1 AND name = $2', [
          row.id,
          row.name,
        ]);
      }
      if (!apply) lines.push('dry run: nothing changed. Add --apply to do it.');
      return lines;
    }
    default:
      throw new UsageError(
        'usage: dead-letters.mjs list | show <id> | redrive <id>|--queue <q> | discard <id> [--apply]',
      );
  }
}

/** A pg-boss that sends through the script's own connection (never started: no timers, no maintenance). */
function defaultBoss(client) {
  const boss = new PgBoss({
    db: {
      executeSql: async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows };
      },
    },
    schema: SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => undefined);
  return boss;
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    console.error('MIGRATE_DATABASE_URL is not set (the venueos_migrator connection).');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    for (const line of await run(client, parsed)) console.log(line);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      // Driver messages can contain the connection string: print the name and code only.
      console.error(`dead-letters failed: ${error.name}${error.code ? ` (${error.code})` : ''}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
