import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { LOGGER } from '../logging/logging.module';
import type { Logger } from '../logging/logging.module';
import { StorageModule } from '../storage/storage.module';
import { ChromiumPdfRenderer, PDF_RENDERER } from './chromium-renderer';
import type { PdfRenderer } from './chromium-renderer';
import { PDF_KIND_HANDLERS } from './pdf-kind';
import { PdfRenderJob } from './pdf-render.job';
import { quotationKind } from './quotation-kind';
import { sampleKind } from './sample-kind';

/**
 * `pdf.render` and what it needs: Chromium, S3 and the document kinds. A module that adds a document adds its
 * kind to `PDF_KIND_HANDLERS` here (quotation, receipt and event sheet arrive with their modules).
 */
@Module({
  imports: [StorageModule],
  providers: [
    {
      provide: PDF_RENDERER,
      inject: [WORKER_CONFIG, LOGGER],
      useFactory: (config: WorkerConfig, logger: Logger) => new ChromiumPdfRenderer(config, logger),
    },
    { provide: PDF_KIND_HANDLERS, useValue: [sampleKind, quotationKind] },
    PdfRenderJob,
  ],
  exports: [PdfRenderJob],
})
export class PdfModule implements OnApplicationShutdown {
  constructor(@Inject(PDF_RENDERER) private readonly renderer: PdfRenderer) {}

  async onApplicationShutdown(): Promise<void> {
    // Close Chromium before the process exits; an orphaned browser would keep running.
    await (this.renderer as { close?: () => Promise<void> }).close?.();
  }
}
