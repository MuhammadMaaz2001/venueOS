import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { requestIdMiddleware } from './common/request-id/request-id';
import { securityHeaders } from './common/security/security-headers';
import { APP_CONFIG, type AppConfig } from './config/config.module';
import { swaggerEnabled } from './config/env.schema';

// Shared by main.ts and the tests so both see the same middleware and routes.
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));

  // Express derives req.ip (used by the throttler and the access log) from X-Forwarded-For using
  // this hop count. It must equal the real number of proxies in front of the API (docs/08).
  app.set('trust proxy', config.TRUST_PROXY);

  // Order matters: the request id first (every later stage and every error carries it), then headers.
  const docsEnabled = swaggerEnabled(config);
  app.use(requestIdMiddleware);
  app.use(securityHeaders(docsEnabled));

  // Business endpoints live under /v1; health checks stay at the root (docs/02-system-design.md).
  // Listed explicitly: wildcard excludes use path-to-regexp syntax that changes between Nest majors.
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });

  if (docsEnabled) SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
}

/** The OpenAPI document, generated from the controllers and their Zod DTOs. Also used by the client generator. */
export function buildOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('venueOS API').setVersion('0.0.0').build(),
  );
  return cleanupOpenApiDoc(document);
}
