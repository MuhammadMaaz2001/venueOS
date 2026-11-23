import { Global, Module } from '@nestjs/common';
import type { Env } from './env.schema';
import { loadEnv } from './load-env';

/** Injection token for the validated environment. Tests override it with `overrideProvider`. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export type WorkerConfig = Env;

@Global()
@Module({
  providers: [{ provide: WORKER_CONFIG, useFactory: (): WorkerConfig => loadEnv() }],
  exports: [WORKER_CONFIG],
})
export class ConfigModule {}
