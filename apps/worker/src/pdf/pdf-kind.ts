import type { DbTx } from '@venueos/db';
import type { PdfRenderPayload } from '@venueos/shared';

/** Injection token for the list of document kinds the worker can render (`PdfKindHandler[]`). */
export const PDF_KIND_HANDLERS = Symbol('PDF_KIND_HANDLERS');

/** What a kind loads from the database to fill its template. */
export interface PdfSource {
  /** Template variables (`{{ a.b }}` in the template). Customer data lives here, never in the job payload. */
  vars: Record<string, unknown>;
  /** Language of the document (the customer's preferred locale, else the tenant's default). */
  locale: string;
}

/**
 * One kind of document (`quotation`, `receipt`, `event-sheet`, ...). A kind says which template to use, how
 * to load its data, and where the resulting KEY is recorded (docs/02: the database stores the key, never a
 * URL). Kinds are registered in `PdfModule`; the job itself knows nothing about any document.
 */
export interface PdfKindHandler {
  readonly kind: string;
  /** Name of the template in `@venueos/templates`. */
  readonly template: string;
  /**
   * Load the data inside the tenant's transaction (Row Level Security applies). Return `null` when the
   * entity does not exist for this tenant (also for another tenant's id): the job fails permanently with
   * `ENTITY_NOT_FOUND`.
   */
  load(tx: DbTx, payload: PdfRenderPayload): Promise<PdfSource | null>;
  /**
   * Record the stored object's key (for example `quotations.pdf_key`), in a short transaction after the
   * upload. Must be idempotent: the job can run twice. Omit for kinds that keep no key.
   */
  saveKey?(tx: DbTx, payload: PdfRenderPayload, key: string): Promise<void>;
}
