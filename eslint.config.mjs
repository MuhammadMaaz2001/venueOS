import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One flat config for the whole monorepo (ESLint finds it from every package directory).

// ── Project rules (CLAUDE.md non-negotiables 1 and docs/04-security.md) ──────────────────────

const NO_DANGEROUS_HTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'dangerouslySetInnerHTML is banned (XSS). Render escaped text or a sanitised component.',
};

const UNSAFE_RAW = '/^\\$(queryRaw|executeRaw)Unsafe$/';
const NO_UNSAFE_RAW = [
  {
    selector: `MemberExpression[property.name=${UNSAFE_RAW}]`,
    message:
      '$queryRawUnsafe/$executeRawUnsafe are banned (SQL injection). Use tagged $queryRaw/$executeRaw. Only packages/db/src/pgboss-adapter.ts may use the unsafe forms.',
  },
  {
    selector: `MemberExpression[property.value=${UNSAFE_RAW}]`,
    message:
      '$queryRawUnsafe/$executeRawUnsafe are banned (SQL injection). Only packages/db/src/pgboss-adapter.ts may use the unsafe forms.',
  },
];

const NO_PRISMA_CLIENT_IMPORT = {
  patterns: [
    {
      group: ['**/generated/prisma', '**/generated/prisma/**'],
      message:
        'The generated Prisma client may only be imported inside packages/db. Use TenantDb / AuthDb from @venueos/db.',
    },
  ],
  paths: [
    {
      name: '@prisma/client',
      message:
        'Never import PrismaClient outside packages/db. Use TenantDb / AuthDb from @venueos/db.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'packages/db/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // docs/07-coding-standards.md: no `any`, no non-null `!` outside tests.
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-imports': ['error', NO_PRISMA_CLIENT_IMPORT],
      'no-restricted-syntax': ['error', NO_DANGEROUS_HTML, ...NO_UNSAFE_RAW],
    },
  },

  // Next.js rules, only for the web app.
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{js,jsx,mjs,ts,tsx}'],
  })),
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The root has no react/pages of its own; tell the plugins where the web app is.
    files: ['apps/web/**/*.{js,jsx,mjs,ts,tsx}'],
    settings: { react: { version: '19' }, next: { rootDir: 'apps/web/' } },
  },

  // packages/db owns the Prisma client and the database drivers.
  {
    files: ['packages/db/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // The one file allowed to use the unsafe raw-query forms (pg-boss needs a raw adapter).
  {
    files: ['packages/db/src/pgboss-adapter.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_DANGEROUS_HTML] },
  },

  // Tests may use `!`.
  {
    files: ['**/*.spec.ts', '**/*.int-spec.ts', '**/__tests__/**', '**/*.test.*'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
