import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { LOGGER } from './logging/logging.module';
import type { Logger } from './logging/logging.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGINT/SIGTERM: running jobs finish, pg-boss and the database pools close.
  app.enableShutdownHooks();
  // A standalone context has no listener; pg-boss's own timers normally keep Node alive, this makes it certain.
  setInterval(() => undefined, 60_000);
  app.get<Logger>(LOGGER).info('worker ready');
}

bootstrap().catch((error: unknown) => {
  // Config errors list variable names only (never values); anything else is reported by name.
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error && error.name === 'ConfigError' ? error.message : '';
  console.error(`worker failed to start: ${name}${message ? `\n${message}` : ''}`);
  process.exit(1);
});
