import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** The only columns a scanner may read: the identifiers of the work it finds. */
const ALLOWED_COLUMNS = new Set(['id', 'tenant_id']);

export interface ScanRow {
  id: string;
  /** Present when the query selects `tenant_id`. */
  tenantId?: string;
}

export class ScanQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanQueryError';
  }
}

export interface PageOptions {
  pageSize?: number;
}

/**
 * The scanner's connection: role `venueos_jobs` (BYPASSRLS, SELECT only on tenants, venues, bookings,
 * booking_sessions, payment_schedule_items, leads, inventory_items). It finds WHAT is due across tenants;
 * the job it enqueues does the work as `venueos_app` inside that tenant (docs/02, docs/04 section 3).
 *
 * "IDs only" is enforced here, not by convention: a query may return nothing but `id` and `tenant_id`
 * (anything else throws `ScanQueryError` before a value leaves this class), and every value must look like an
 * identifier. Queries are static SQL text written in the scanner (never built from input) with `$n`
 * parameters; this class adds the keyset pagination around them.
 */
@Injectable()
export class ScannerDb implements OnApplicationShutdown {
  private readonly pool: pg.Pool;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.pool = new pg.Pool({
      connectionString: config.JOBS_DATABASE_URL,
      max: 2,
      application_name: 'venueos-worker-scanner',
    });
    // An idle client can fail (database restart); without a listener that would crash the process.
    this.pool.on('error', () => undefined);
  }

  /**
   * Walk the result of `text` in pages of ids, ordered by `id`.
   *
   * `text` selects `id` (and optionally `tenant_id`) and must not end in `;`, `ORDER BY` or `LIMIT`:
   * `SELECT id FROM tenants WHERE status = $1`. Pages are fetched with `id > last ORDER BY id LIMIT n`, so
   * a long scan holds no cursor or transaction open between pages.
   */
  async *pages(
    text: string,
    values: readonly unknown[] = [],
    options: PageOptions = {},
  ): AsyncGenerator<ScanRow[]> {
    if (text.includes(';')) throw new ScanQueryError('a scan query must be a single statement');
    const pageSize = options.pageSize ?? 500;
    const after = values.length + 1;
    const limit = values.length + 2;
    const paged = `SELECT * FROM (${text}) AS scan WHERE id > $${after} ORDER BY id LIMIT $${limit}`;
    let last = '';
    for (;;) {
      const result = await this.pool.query<Record<string, unknown>>(paged, [
        ...values,
        last,
        pageSize,
      ]);
      const rows = result.rows.map(toScanRow);
      if (rows.length === 0) return;
      yield rows;
      last = rows[rows.length - 1]?.id ?? last;
      if (rows.length < pageSize) return;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

function toScanRow(row: Record<string, unknown>): ScanRow {
  for (const column of Object.keys(row)) {
    if (!ALLOWED_COLUMNS.has(column)) {
      throw new ScanQueryError('a scan query may only select id and tenant_id');
    }
  }
  const { id, tenant_id: tenantId } = row;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ScanQueryError('a scan query must select an identifier as id');
  }
  if (tenantId === undefined) return { id };
  if (typeof tenantId !== 'string' || !ID_PATTERN.test(tenantId)) {
    throw new ScanQueryError('tenant_id is not an identifier');
  }
  return { id, tenantId };
}
