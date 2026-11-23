import { Global, Module } from '@nestjs/common';
import type { Env } from './env.schema';
import { loadEnv } from './load-env';

/** Injection token for the validated environment. Tests override it with `overrideProvider`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = Env;

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadEnv() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
