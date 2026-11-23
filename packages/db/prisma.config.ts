import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations and the seed run as the venueos_migrator role (owns the schema, not a superuser).
// The fallback has no credentials: it only lets commands that never connect (validate, generate,
// `migrate diff --from-empty`, used by the constraint test before migrations exist) run
// without a .env. Commands that connect fail with an auth error instead of using a guessed login.
const url = process.env.MIGRATE_DATABASE_URL ?? 'postgresql://localhost:5432/venueos';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: { url },
});
