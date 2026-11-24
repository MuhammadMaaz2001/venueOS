import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * The login and mail limits count per IP address in the database (docs/04 section 1: 20 per 15 minutes), and
 * every browser of a test run comes from 127.0.0.1. Before the run, forget those counters so repeated local
 * runs do not lock themselves out. Only ever done against a database on this machine.
 */
function authDatabaseUrl(): string | undefined {
  if (process.env.E2E_AUTH_DATABASE_URL) return process.env.E2E_AUTH_DATABASE_URL;
  try {
    const env = fs.readFileSync(path.resolve(__dirname, '../../api/.env'), 'utf8');
    return /^AUTH_DATABASE_URL=(.+)$/m.exec(env)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** The web server answers long before the API and the worker are up; wait for the API's readiness check. */
async function waitForApi(): Promise<void> {
  const url = `${process.env.E2E_API_URL ?? 'http://localhost:4000'}/health/ready`;
  const deadline = Date.now() + 240_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`The API did not become ready at ${url} (${last}). Is the stack running?`);
}

export default async function globalSetup(): Promise<void> {
  await waitForApi();

  const url = authDatabaseUrl();
  if (!url) {
    console.warn('e2e: no AUTH_DATABASE_URL found, the per-IP limits are not reset');
    return;
  }
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.warn(`e2e: ${host} is not a local database, the per-IP limits are not reset`);
    return;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DELETE FROM login_attempts');
    await client.query('DELETE FROM auth_requests');
  } finally {
    await client.end();
  }
}
