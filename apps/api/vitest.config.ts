import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts'],
    environment: 'node',
    // Integration tests boot the whole Nest app (and open DB connections); keep them predictable.
    testTimeout: 20_000,
  },
  plugins: [
    // esbuild (vitest's default) does not emit decorator metadata, which Nest's constructor
    // injection needs. SWC does, matching what tsc emits for the real build.
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
