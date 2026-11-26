#!/usr/bin/env node
// Runs `next dev` or `next start` on the port of WEB_PORT (default 3000).
//
//   node scripts/next-port.mjs dev|start
//
// WEB_PORT comes from the environment first, then from apps/web/.env, then from the repository's root .env (where
// docker compose reads it too, so the container and the dev server move together). The API's port is its own PORT
// (apps/api/.env); keep API_INTERNAL_URL (apps/web/.env) and APP_ORIGIN (api and worker) in step with both
// (README, "Getting started").

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..');

function fromFile(file, key) {
  try {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'));
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: next-port.mjs dev|start');
  process.exit(2);
}

const raw =
  process.env.WEB_PORT?.trim() ||
  fromFile(resolve(webDir, '.env'), 'WEB_PORT') ||
  fromFile(resolve(webDir, '../../.env'), 'WEB_PORT') ||
  '3000';
const port = Number(raw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`WEB_PORT must be a port number, got "${raw}"`);
  process.exit(2);
}

const nextBin = createRequire(resolve(webDir, 'package.json')).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, mode, '--port', String(port)], {
  cwd: webDir,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
