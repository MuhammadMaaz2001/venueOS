import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { JobQueue, TenantDb, createSealer } from '@venueos/db';
import type { JobQueueOptions, Sealer } from '@venueos/db';
import pg from 'pg';
import { WORKER_CONFIG } from '../../config/config.module';
import type { WorkerConfig } from '../../config/config.module';
import { loadEnv } from '../../config/load-env';
import { EMAIL_PROVIDER } from '../../email/email-provider';
import type { EmailProvider } from '../../email/email-provider';
import { LOGGER, createLogger } from '../../logging/logging.module';
import { WorkerModule } from '../../worker.module';

// vitest does not read .env files. Variables already in the environment win (CI sets them).
for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file missing: fine
  }
}

/** Test-only keyring (32 bytes of 7). The worker under test and the enqueue side share it, like in production. */
export const TEST_KEYRING = { active: 'k1', keys: { k1: Buffer.alloc(32, 7).toString('base64') } };

export const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

/** Valid test configuration; `overrides` replace single variables. */
export function testConfig(overrides: Record<string, string> = {}): WorkerConfig {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    JOBS_DATABASE_URL: process.env.JOBS_DATABASE_URL,
    FIELD_ENCRYPTION_KEYS: JSON.stringify(TEST_KEYRING),
    EMAIL_PROVIDER: 'smtp',
    SMTP_URL: process.env.SMTP_URL ?? 'smtp://localhost:1025',
    EMAIL_FROM_ADDRESS: 'bookings@venueos.test',
    JOB_POLLING_INTERVAL_SECONDS: '0.5',
    JOB_CONCURRENCY: '2',
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

export interface RunningWorker {
  /** Parsed JSON log lines written so far. */
  logLines: () => Record<string, unknown>[];
  /** Raw log output, for "this never appears anywhere" assertions. */
  rawLogs: () => string;
  stop: () => Promise<void>;
}

/** Boot the real WorkerModule (pg-boss as venueos_jobs, handlers as venueos_app). */
export async function startWorker(
  options: { env?: Record<string, string>; provider?: EmailProvider } = {},
): Promise<RunningWorker> {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const config = testConfig(options.env);
  let builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(WORKER_CONFIG)
    .useValue(config)
    .overrideProvider(LOGGER)
    .useValue(createLogger(config.LOG_LEVEL, stream));
  if (options.provider)
    builder = builder.overrideProvider(EMAIL_PROVIDER).useValue(options.provider);
  const moduleRef: TestingModule = await builder.compile();
  await moduleRef.init();
  return {
    logLines: () =>
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    rawLogs: () => output,
    stop: () => moduleRef.close(),
  };
}

export interface Fixture {
  tenantDb: TenantDb;
  /** Seals secret variables the way the API does. */
  sealer: Sealer;
  queue: JobQueue;
  /** Reads pgboss.* and message_logs directly (table owner; for assertions only). */
  admin: pg.Client;
  close: () => Promise<void>;
}

/** Database access for a test file: the enqueue side (as the API does it) plus an assertion client. */
export async function createFixture(retry?: JobQueueOptions['retry']): Promise<Fixture> {
  const tenantDb = new TenantDb({ connectionString: process.env.DATABASE_URL ?? '', poolMax: 4 });
  const queue = new JobQueue({
    connectionString: process.env.DATABASE_URL ?? '',
    ...(retry ? { retry } : {}),
  });
  const admin = new pg.Client({ connectionString: process.env.VENUEOS_TEST_MIGRATOR_URL });
  await admin.connect();
  return {
    tenantDb,
    sealer: createSealer(TEST_KEYRING),
    queue,
    admin,
    close: async () => {
      await queue.close();
      await tenantDb.close();
      await admin.end();
    },
  };
}

/** Create a tenant (as the app role, in its own tenant context, like signup does). */
export async function createTenant(tenantDb: TenantDb, name = 'Royal Hall'): Promise<string> {
  const id = `tw_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await tenantDb.tx({ tenantId: id }, (tx) =>
    tx.tenant.create({
      data: {
        id,
        slug: id.replace(/_/g, '-'),
        name,
        country: 'PK',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        status: 'ACTIVE',
      },
    }),
  );
  return id;
}

/** A recipient address no other test uses (so Mailpit searches never collide). */
export const uniqueRecipient = (): string => `guest-${randomUUID().slice(0, 8)}@example.test`;

export async function eventually<T>(
  check: () => Promise<T | undefined | false | null>,
  { timeoutMs = 30_000, intervalMs = 250, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface MailpitSummary {
  ID: string;
}
export interface MailpitMessage {
  ID: string;
  Subject: string;
  HTML: string;
  Text: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  ReplyTo: { Name: string; Address: string }[];
}

export async function mailpitMessagesTo(address: string): Promise<MailpitMessage[]> {
  const search = await fetch(
    `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  if (!search.ok)
    throw new Error(
      `Mailpit search failed (${search.status}); is Mailpit running on ${MAILPIT_API}?`,
    );
  const { messages } = (await search.json()) as { messages: MailpitSummary[] };
  return Promise.all(
    messages.map(async (m) => {
      const res = await fetch(`${MAILPIT_API}/api/v1/message/${m.ID}`);
      return (await res.json()) as MailpitMessage;
    }),
  );
}

export interface MessageLogRow {
  status: string;
  error: string | null;
  attempt: number | null;
  is_final: boolean;
  provider_ref: string | null;
  to: string;
  template: string | null;
}

export async function messageLog(
  admin: pg.Client,
  tenantId: string,
  messageKey: string,
): Promise<MessageLogRow[]> {
  // The table owner is subject to FORCE RLS too: set the tenant for this one read.
  await admin.query('BEGIN');
  try {
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await admin.query<MessageLogRow>(
      `SELECT status, error, attempt, is_final, provider_ref, "to", template
         FROM message_logs WHERE message_key = $1 ORDER BY created_at, id`,
      [messageKey],
    );
    return rows;
  } finally {
    await admin.query('ROLLBACK');
  }
}

export interface JobRow {
  name: string;
  state: string;
  retry_count: number;
  data: Record<string, unknown>;
  output: Record<string, unknown> | null;
}

export async function jobsFor(admin: pg.Client, messageKey: string): Promise<JobRow[]> {
  const { rows } = await admin.query<JobRow>(
    `SELECT name, state, retry_count, data, output FROM pgboss.job
      WHERE data->>'messageKey' = $1 ORDER BY created_on, name`,
    [messageKey],
  );
  return rows;
}
