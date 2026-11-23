import { Global, Module } from '@nestjs/common';
import pino from 'pino';
import type { Logger } from 'pino';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';

export type { Logger };

/** Injection token for the root logger. Tests override it with a logger writing to a stream. */
export const LOGGER = Symbol('LOGGER');

/**
 * Safety net, not a licence (docs/04-security.md section 9): job code logs identifiers and short codes
 * only. These keys are blanked wherever they appear, in case someone logs a whole object by mistake.
 */
export const REDACT_PATHS = [
  'to',
  'replyTo',
  'html',
  'text',
  'subject',
  'body',
  'vars',
  'templateVars',
  '*.to',
  '*.replyTo',
  '*.html',
  '*.text',
  '*.subject',
  '*.body',
  '*.vars',
  '*.templateVars',
  'password',
  'token',
  'authorization',
  'connectionString',
  '*.password',
  '*.token',
  '*.connectionString',
];

export function createLogger(
  level: WorkerConfig['LOG_LEVEL'],
  destination?: NodeJS.WritableStream,
): Logger {
  return pino(
    {
      level,
      base: { app: 'worker' },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): Logger => createLogger(config.LOG_LEVEL),
    },
  ],
  exports: [LOGGER],
})
export class LoggingModule {}
