import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  // A standalone context has no listener, so Node would exit at once. Hold the process open;
  // shutdown hooks end it on SIGINT/SIGTERM. pg-boss keeps it alive on its own from P0-6a.
  setInterval(() => undefined, 60_000);

  new Logger('Worker').log('worker ready');
}

void bootstrap();
