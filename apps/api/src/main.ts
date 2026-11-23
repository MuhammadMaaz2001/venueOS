import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { ConfigError, loadEnv } from './config/load-env';

async function bootstrap(): Promise<void> {
  // Fail fast: validate the whole environment before anything is created or listening.
  const config = loadEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.PORT);
  app.get(Logger).log(`API listening on :${config.PORT}`);
}

bootstrap().catch((error: unknown) => {
  // Config errors list variable names and reasons only (never values), so they are safe to print.
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('API failed to start:', error);
  }
  process.exit(1);
});
