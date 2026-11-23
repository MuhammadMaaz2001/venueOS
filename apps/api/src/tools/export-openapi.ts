import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module';
import { buildOpenApiDocument, configureApp } from '../configure-app';

// Writes the OpenAPI document without listening on a port or touching the database (the readiness
// pool connects lazily). Run by `pnpm api-client:generate`. The placeholders below only satisfy the
// config schema; they are never used to connect anywhere.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@localhost:5432/openapi';
process.env.AUTH_DATABASE_URL ??= 'postgresql://openapi:openapi@localhost:5432/openapi';
process.env.FIELD_ENCRYPTION_KEYS ??= JSON.stringify({
  active: 'openapi',
  keys: { openapi: Buffer.alloc(32).toString('base64') },
});
process.env.APP_ORIGIN ??= 'http://localhost:3000';
process.env.LOG_LEVEL = 'silent';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error('usage: export-openapi <output.json>');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app);
  const document = buildOpenApiDocument(app);
  await app.close();

  const file = resolve(target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`OpenAPI document written to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
