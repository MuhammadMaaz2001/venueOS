import { Module } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClsServiceManager } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import type { Options } from 'pino-http';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import type { RequestContext } from '../context/request-context';
import { REDACT_CENSOR, buildRedactPaths } from './redaction';

/** Where log lines go. Undefined = stdout; the tests replace it with an in-memory stream. */
export const LOG_STREAM = Symbol('LOG_STREAM');

@Module({
  providers: [{ provide: LOG_STREAM, useValue: undefined }],
  exports: [LOG_STREAM],
})
class LogStreamModule {}

interface SerializedRequest {
  id?: string;
  method?: string;
  url?: string;
  raw?: IncomingMessage & { ip?: string };
}

/**
 * Allow-list serializer: method and path only. Headers (cookie, authorization), bodies and query
 * strings (which can carry emails or phone numbers) are never logged. `ip` is Express's `req.ip`,
 * i.e. the client address after `trust proxy`, not the address of the web server in front of us.
 */
export function serializeRequest(req: SerializedRequest): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    path: (req.url ?? '').split('?')[0],
    ip: req.raw?.ip,
  };
}

function isHealthCheck(req: IncomingMessage): boolean {
  const path = (req.url ?? '').split('?')[0];
  return path === '/health' || path === '/health/ready';
}

// Driver errors sometimes embed the connection string (postgresql://user:password@host/db) in their
// message or stack. Credentials inside any URL are masked before the error is written.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;

export function scrubUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACT_CENSOR}@`);
}

export function serializeError(error: Error): Record<string, unknown> {
  const serialized = pino.stdSerializers.err(error);
  return {
    ...serialized,
    message: scrubUrlCredentials(serialized.message),
    stack: serialized.stack === undefined ? undefined : scrubUrlCredentials(serialized.stack),
  };
}

export function buildPinoOptions(config: AppConfig): Options {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: buildRedactPaths(), censor: REDACT_CENSOR },
    // Every line logged inside a request carries requestId / tenantId / userId from CLS. The guards
    // of P0-4 / P0-5 fill tenantId and userId; until then only requestId is present.
    mixin: () => {
      const cls = ClsServiceManager.getClsService<RequestContext>();
      if (!cls.isActive()) return {};
      return {
        requestId: cls.get('requestId'),
        tenantId: cls.get('tenantId'),
        userId: cls.get('userId'),
      };
    },
    genReqId: (req: IncomingMessage) => (req as { id?: string }).id ?? '',
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
      if (err || res.statusCode >= 500) return 'error' as const;
      return res.statusCode >= 400 ? ('warn' as const) : ('info' as const);
    },
    autoLogging: { ignore: isHealthCheck },
    serializers: {
      req: serializeRequest,
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: serializeError,
    },
    // The filter logs the real exception; pino-http's own synthetic "failed with status code" error
    // would only repeat the status with an unrelated stack.
    customErrorObject: (_req, _res, _error, val) => ({ ...val, err: undefined }),
  };
}

export const loggingModule = LoggerModule.forRootAsync({
  imports: [LogStreamModule],
  inject: [APP_CONFIG, LOG_STREAM],
  useFactory: (config: AppConfig, stream: DestinationStream | undefined) => ({
    pinoHttp: stream ? [buildPinoOptions(config), stream] : buildPinoOptions(config),
  }),
});
