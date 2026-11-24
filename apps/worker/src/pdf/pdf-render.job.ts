import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { JOB_NAMES, PDF_MAX_BYTES, pdfObjectKey, pdfRenderPayloadSchema } from '@venueos/shared';
import type { PdfFailureCode, PdfRenderPayload } from '@venueos/shared';
import { TemplateError, UnknownPdfTemplateError, renderPdfHtml } from '@venueos/templates';
import { PermanentJobError, RetryableJobError, TenantJob } from '../jobs/tenant-job';
import type { JobContext } from '../jobs/tenant-job';
import {
  InvalidObjectKeyError,
  OBJECT_STORAGE,
  assertTenantObjectKey,
} from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { PDF_RENDERER, PdfRenderError } from './chromium-renderer';
import type { PdfRenderer } from './chromium-renderer';
import { PDF_KIND_HANDLERS } from './pdf-kind';
import type { PdfKindHandler } from './pdf-kind';

/**
 * `pdf.render`: renders one document to PDF and stores it. Payload `{ tenantId, kind, entityId }` only.
 *
 *   1. short transaction: the kind loads its data (RLS applies; another tenant's id finds nothing);
 *   2. no transaction: fill the template, render in Chromium, upload to S3 under
 *      `tenants/{tenantId}/pdf/{kind}/{entityId}.pdf`;
 *   3. short transaction: the kind records the KEY (never a URL).
 *
 * The key is derived from the payload, so a retry or a second delivery overwrites the same object and
 * records the same key. Failures use fixed codes: retried `RENDER_TIMEOUT`, `BROWSER_UNAVAILABLE`,
 * `STORAGE_UNAVAILABLE`, `UNEXPECTED`; permanent (dead letter at once) `UNKNOWN_KIND`, `ENTITY_NOT_FOUND`,
 * `TEMPLATE_ERROR`, `TOO_LARGE`. The output of a finished job is the key and the size, nothing else.
 */
@Injectable()
export class PdfRenderJob extends TenantJob<PdfRenderPayload> {
  readonly queue = JOB_NAMES.PDF_RENDER;
  protected readonly payloadSchema = pdfRenderPayloadSchema;
  private readonly kinds: ReadonlyMap<string, PdfKindHandler>;

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(PDF_KIND_HANDLERS) handlers: PdfKindHandler[],
  ) {
    super(tenantDb);
    this.kinds = new Map(handlers.map((h) => [h.kind, h]));
  }

  protected async handle(ctx: JobContext<PdfRenderPayload>) {
    const { payload } = ctx;
    const handler = this.kinds.get(payload.kind);
    if (!handler) throw fail('UNKNOWN_KIND');

    const source = await ctx.tx((tx) => handler.load(tx, payload));
    if (!source) throw fail('ENTITY_NOT_FOUND');

    let html: string;
    try {
      html = renderPdfHtml(handler.template, source.locale, source.vars).html;
    } catch (error) {
      if (error instanceof TemplateError || error instanceof UnknownPdfTemplateError) {
        throw fail('TEMPLATE_ERROR');
      }
      throw error;
    }

    let pdf: Buffer;
    try {
      pdf = await this.renderer.render(html);
    } catch (error) {
      if (error instanceof PdfRenderError) throw retry(error.code);
      throw error;
    }
    if (pdf.length > PDF_MAX_BYTES) throw fail('TOO_LARGE');

    const key = pdfObjectKey(payload.tenantId, payload.kind, payload.entityId);
    try {
      assertTenantObjectKey(key, payload.tenantId);
    } catch (error) {
      if (error instanceof InvalidObjectKeyError) throw fail('INVALID_PAYLOAD');
      throw error;
    }
    try {
      await this.storage.put(key, pdf, 'application/pdf');
    } catch {
      throw retry('STORAGE_UNAVAILABLE');
    }

    if (handler.saveKey) {
      const save = handler.saveKey.bind(handler);
      await ctx.tx((tx) => save(tx, payload, key));
    }
    ctx.log.info({ kind: payload.kind, bytes: pdf.length }, 'pdf rendered and stored');
    return { key, bytes: pdf.length };
  }
}

const fail = (code: PdfFailureCode): PermanentJobError => new PermanentJobError(code);
const retry = (code: PdfFailureCode): RetryableJobError => new RetryableJobError(code);
