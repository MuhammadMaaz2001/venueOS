#!/usr/bin/env node
// Dev runner for the Nest apps (api, worker). Run from the app's folder:
//   node ../../scripts/dev-node.mjs [node flags, e.g. --env-file-if-exists=.env]
//
// It runs two things side by side:
//   1. `tsc --watch` on the app's own sources (tsconfig.build.json), writing to dist/.
//   2. `node --watch` on dist/main.js that restarts when the app's own dist OR the compiled dist of
//      a workspace package it consumes (packages/shared, packages/db) changes.
//
// Why not `nest start --watch`: it only recompiles when a .ts/.d.ts file in the TypeScript program
// changes, so a change that only alters a library's emitted JavaScript never restarts the app; and
// on Windows its process-tree kill fails when the child is `node --watch` (taskkill "could not be
// terminated"), which takes the whole dev server down. `nest build` is still used for production.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const appDir = process.cwd();
const entry = resolve(appDir, 'dist/main.js');
const nodeFlags = process.argv.slice(2);

// Workspace packages the apps import as compiled `dist` (see turbo.json: dev depends on ^build).
const watchedPackages = ['shared', 'db'];
const watchPaths = [
  resolve(appDir, 'dist'),
  ...watchedPackages
    .map((name) => resolve(appDir, '../../packages', name, 'dist'))
    .filter(existsSync),
];

const require = createRequire(resolve(appDir, 'package.json'));
const tscBin = require.resolve('typescript/bin/tsc');

const children = [];
function run(args, name) {
  const child = spawn(process.execPath, args, { cwd: appDir, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited (${signal ?? code}); stopping`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0));

run([tscBin, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], 'tsc');

// The first compile may not have written dist yet (fresh clone): wait for the entry point.
const waitForEntry = setInterval(() => {
  if (!existsSync(entry)) return;
  clearInterval(waitForEntry);
  console.log(`[dev] watching ${watchPaths.length} folders for restarts`);
  run(
    [
      '--enable-source-maps',
      ...nodeFlags,
      ...watchPaths.map((path) => `--watch-path=${path}`),
      '--watch-preserve-output',
      entry,
    ],
    'node',
  );
}, 200);
