import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../config/env.schema';
import { loadEnv } from '../config/load-env';

// The test-only connection settings (VENUEOS_TEST_ADMIN_URL: a database SUPERUSER, VENUEOS_TEST_SUPERUSER_URL:
// the same superuser on the throwaway test database, and the other VENUEOS_TEST_* values) exist so that tests
// can create databases and read rows that row level security hides from the application roles. Application
// code must never read them, and no app may accept them as configuration: a superuser URL in a running app's
// environment would undo the database role design (docs/04-security.md section 3).

const REPO = path.resolve(process.cwd(), '..', '..');
const NAMES = ['VENUEOS_TEST_ADMIN_URL', 'VENUEOS_TEST_SUPERUSER_URL'];
const PREFIX = 'VENUEOS_TEST_';

/** Folders whose files may read the test settings: test setup and test code only. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
  'generated',
  '.claude',
]);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(
  dir: string,
  visit: (file: string, insideTestDir: boolean) => void,
  insideTestDir = false,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(full, visit, insideTestDir || TEST_DIRS.has(entry.name));
    } else if (CODE_FILE.test(entry.name)) {
      visit(full, insideTestDir);
    }
  }
}

function scan(): { all: string[]; outsideTests: Record<string, string[]> } {
  const all: string[] = [];
  const outsideTests: Record<string, string[]> = {};
  const visit = (file: string, insideTestDir: boolean): void => {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    all.push(rel);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(PREFIX)) return;
    if (!insideTestDir) {
      outsideTests[rel] = [...text.matchAll(/VENUEOS_TEST_[A-Z0-9_]+/g)].map((m) => m[0]);
    }
  };
  for (const top of ['apps', 'packages', 'scripts']) walk(path.join(REPO, top), visit);
  // Root-level config files (eslint, prettier, tsconfig helpers, ...).
  for (const entry of readdirSync(REPO, { withFileTypes: true })) {
    if (entry.isFile() && CODE_FILE.test(entry.name)) visit(path.join(REPO, entry.name), false);
  }
  return { all, outsideTests };
}

describe('the test-only database settings stay in test code', () => {
  it('no file outside test/, tests/ and __tests__/ mentions a VENUEOS_TEST_* setting', () => {
    const { all, outsideTests } = scan();
    // The scan really covers the repository (a wrong REPO path would make this test pass vacuously).
    expect(all.length).toBeGreaterThan(150);
    expect(all).toContain('apps/api/src/app.module.ts');
    expect(all).toContain('apps/worker/src/worker.module.ts');
    expect(all).toContain('packages/db/src/tenant-db.ts');
    expect(all).toContain('packages/db/prisma/seed.ts');
    expect(outsideTests).toEqual({});
  });

  it('the scan does see the settings where they ARE allowed (the test setup files)', () => {
    const readers: string[] = [];
    walk(path.join(REPO, 'apps'), (file, insideTestDir) => {
      if (insideTestDir && NAMES.some((n) => readFileSync(file, 'utf8').includes(n))) {
        readers.push(path.relative(REPO, file).split(path.sep).join('/'));
      }
    });
    walk(path.join(REPO, 'packages'), (file, insideTestDir) => {
      if (insideTestDir && NAMES.some((n) => readFileSync(file, 'utf8').includes(n))) {
        readers.push(path.relative(REPO, file).split(path.sep).join('/'));
      }
    });
    expect(readers).toEqual(
      expect.arrayContaining([
        'apps/api/test/global-setup.mjs',
        'apps/api/src/__tests__/helpers/auth-harness.ts',
        'packages/db/tests/helpers/test-db.mjs',
      ]),
    );
  });

  it('no application environment schema declares one (API: the schema itself; worker: its source)', () => {
    const apiKeys = Object.keys(EnvSchema.shape);
    for (const name of NAMES) expect(apiKeys).not.toContain(name);
    expect(apiKeys.filter((k) => k.startsWith(PREFIX))).toEqual([]);

    // The worker has its own schema (a refined object, so read its source rather than its shape).
    const workerSchema = readFileSync(
      path.join(REPO, 'apps', 'worker', 'src', 'config', 'env.schema.ts'),
      'utf8',
    );
    expect(workerSchema).not.toContain(PREFIX);
    const apiSchema = readFileSync(
      path.join(process.cwd(), 'src', 'config', 'env.schema.ts'),
      'utf8',
    );
    expect(apiSchema).not.toContain(PREFIX);
  });

  it('loading the environment drops them: they never reach the application configuration', () => {
    const config = loadEnv({
      DATABASE_URL: 'postgresql://venueos_app:x@localhost:5432/venueos',
      AUTH_DATABASE_URL: 'postgresql://venueos_auth:x@localhost:5432/venueos',
      FIELD_ENCRYPTION_KEYS: '{"active":"k1","keys":{"k1":"abc"}}',
      APP_ORIGIN: 'http://localhost:3000',
      VENUEOS_TEST_ADMIN_URL: 'postgresql://postgres:secret@localhost:5432/postgres',
      VENUEOS_TEST_SUPERUSER_URL: 'postgresql://postgres:secret@localhost:5432/test',
    });
    expect(Object.keys(config).filter((k) => k.startsWith(PREFIX))).toEqual([]);
    expect(JSON.stringify(config)).not.toContain('postgres:secret');
  });
});
