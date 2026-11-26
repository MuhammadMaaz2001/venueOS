import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Where the stack under test listens, and a check that what answers there IS venueOS (another project may use the
// port). The ports come from the environment, then from the local .env files (the same ones `pnpm dev` reads), then
// default to 3000 / 4000, which is what CI uses.

const WEB_DIR = path.resolve(__dirname, '../..');

function fromFile(file: string, key: string): string | undefined {
  try {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(file, 'utf8'));
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Environment first, then apps/web/.env, then the root .env. */
function setting(key: string): string | undefined {
  return (
    process.env[key]?.trim() ||
    fromFile(path.join(WEB_DIR, '.env'), key) ||
    fromFile(path.join(WEB_DIR, '../../.env'), key) ||
    undefined
  );
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** The web app's origin: what the browser opens, and what the emails' links start with (APP_ORIGIN of the api and worker). */
export const WEB_URL = trimSlash(
  process.env.E2E_BASE_URL ?? `http://localhost:${setting('WEB_PORT') ?? '3000'}`,
);

/** The API's own address (not through the web proxy). */
export const API_URL = trimSlash(
  process.env.E2E_API_URL ?? setting('API_INTERNAL_URL') ?? 'http://localhost:4000',
);

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type Probe = { state: 'free' } | { state: 'venueos' } | { state: 'foreign'; detail: string };

// Runs in a child process so the (synchronous) Playwright config can look at the network.
const PROBE = `
const url = process.argv[1] + '/health/ready';
fetch(url, { signal: AbortSignal.timeout(8000) })
  .then(async (res) => {
    let body = null;
    try { body = await res.json(); } catch {}
    const ours = body && typeof body === 'object' && typeof body.status === 'string' &&
      body.checks && typeof body.checks === 'object' && 'database' in body.checks && 'queue' in body.checks;
    console.log(JSON.stringify(ours ? { state: 'venueos' } : { state: 'foreign', detail: 'HTTP ' + res.status + ' without the venueOS health shape' }));
  })
  .catch((error) => {
    const code = error && (error.cause?.code ?? error.code);
    console.log(JSON.stringify(code === 'ECONNREFUSED' || code === 'ECONNRESET'
      ? { state: 'free' }
      : { state: 'foreign', detail: String(error?.cause?.code ?? error?.name ?? error) }));
  });
`;

/** GET `<base>/health/ready` (for the web app that is `/api/health/ready`, through the proxy). */
export function probe(base: string): Probe {
  try {
    const out = execFileSync(process.execPath, ['-e', PROBE, base], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return JSON.parse(out.trim()) as Probe;
  } catch (error) {
    return { state: 'foreign', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Refuses to test a foreign app. A free port is fine (Playwright starts the stack there); an answer that is not
 * venueOS's health response means another project owns the port, and testing it would only produce confusing
 * failures, so stop with a message that says what to change.
 */
export function assertVenueOsOrFree(): void {
  const web = probe(`${WEB_URL}/api`);
  const api = probe(API_URL);
  const problems: string[] = [];
  if (web.state === 'foreign') {
    problems.push(
      `${WEB_URL}/api/health/ready does not answer like venueOS (${web.detail}). Another project may be using that port, or the API behind the web app is not venueOS.`,
    );
  }
  if (api.state === 'foreign') {
    problems.push(
      `${API_URL}/health/ready does not answer like the venueOS API (${api.detail}). Another project may be using that port.`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      [
        'The e2e run was stopped before it touched anything: it will not test an app that is not venueOS.',
        ...problems.map((p) => `  - ${p}`),
        'Move venueOS to free ports (WEB_PORT in the root .env, PORT in apps/api/.env, API_INTERNAL_URL in apps/web/.env,',
        'APP_ORIGIN in apps/api/.env and apps/worker/.env; README, "Getting started"), or stop the other app.',
        'E2E_BASE_URL and E2E_API_URL override the addresses used here.',
      ].join('\n'),
    );
  }
}
