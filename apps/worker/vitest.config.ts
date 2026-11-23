import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts'],
    environment: 'node',
    // One throwaway migrated Postgres for the run; sets DATABASE_URL and JOBS_DATABASE_URL.
    globalSetup: ['./test/global-setup.mjs'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The integration specs share one database and one Mailpit inbox; run files one after another.
    fileParallelism: false,
  },
  plugins: [
    // esbuild (vitest's default) does not emit decorator metadata, which Nest's constructor injection
    // needs. SWC does, matching what tsc emits for the real build.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
