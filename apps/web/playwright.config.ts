import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { WEB_URL, assertVenueOsOrFree } from './e2e/support/stack';

// End-to-end tests of the real stack: Next.js (web, WEB_PORT, default 3000), the API (PORT of apps/api/.env, default 4000),
// the worker (sends the emails) and the docker Postgres + Mailpit (`docker compose up -d postgres mailpit`). `pnpm dev` of
// the repository root starts the three apps; a stack that is already running is reused, but only after it answered like
// venueOS (another project may own the port: then the run stops with a message instead of testing it). The addresses come
// from the environment, then the local .env files (e2e/support/stack.ts); CI keeps 3000 / 4000.
//
//   pnpm --filter @venueos/web e2e                 the journeys (English)
//   pnpm --filter @venueos/web e2e:screenshots     the report screenshots (login, shell, staff; desktop/360 px)
const BASE_URL = WEB_URL;
assertVenueOsOrFree();

export default defineConfig({
  testDir: './e2e',
  // One browser at a time: the journeys share one database and the per-IP login limits (docs/04 section 1).
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  outputDir: './e2e/.results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'journeys', testMatch: /.*\.spec\.ts/, testIgnore: /screenshots\.spec\.ts/ },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: 'pnpm dev',
    cwd: path.resolve(__dirname, '../..'),
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
