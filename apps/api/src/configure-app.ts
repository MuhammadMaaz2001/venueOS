import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

// Shared by main.ts and the tests so both see the same routes.
export function configureApp(app: INestApplication): void {
  // Business endpoints live under /v1; health checks stay at the root (docs/02-system-design.md).
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/(.*)'] });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('venueOS API').setVersion('0.0.0').build(),
  );
  SwaggerModule.setup('docs', app, document);
}
