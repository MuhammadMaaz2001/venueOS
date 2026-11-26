import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_NAMES, PDF_MAX_BYTES, pdfObjectKey } from '@venueos/shared';
import type { PdfRenderPayload } from '@venueos/shared';
import { PdfRenderError } from '../pdf/chromium-renderer';
import type { PdfRenderer } from '../pdf/chromium-renderer';
import type { PdfKindHandler } from '../pdf/pdf-kind';
import { PgBossService } from '../queue/pg-boss.service';
import { StorageError, assertTenantObjectKey } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import {
  TEST_BUCKET,
  createFixture,
  createTenant,
  ensureTestBucket,
  eventually,
  jobsOfQueue,
  startWorker,
  testS3,
} from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// pdf.render end to end: real Postgres + pg-boss for the queue, the REAL Chromium and the REAL local S3 (SeaweedFS) for
// the happy path, scripted renderer/storage for the failure paths.

const FAKE_PDF = Buffer.from('%PDF-1.7\nfake\n%%EOF\n');

class ScriptedRenderer implements PdfRenderer {
  calls = 0;
  constructor(private readonly script: (call: number) => Buffer | Error) {}
  render(): Promise<Buffer> {
    this.calls += 1;
    const result = this.script(this.calls);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

class ScriptedStorage implements ObjectStorage {
  puts: { key: string; bytes: number; contentType: string }[] = [];
  attempts = 0;
  constructor(private readonly failFirst = 0) {}
  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failFirst) return Promise.reject(new StorageError());
    this.puts.push({ key, bytes: body.length, contentType });
    return Promise.resolve();
  }
  get(): Promise<Buffer> {
    return Promise.reject(new StorageError());
  }
}

/** A kind that records the key it is handed, and reads another tenant's row on request (RLS must hide it). */
const savedKeys: { entityId: string; key: string }[] = [];
const keyedKind: PdfKindHandler = {
  kind: 'keyed',
  template: 'sample',
  async load(tx, payload) {
    const own = await tx.tenant.findUnique({ where: { id: payload.tenantId } });
    if (!own) return null;
    return {
      locale: 'en',
      vars: { tenantName: own.name, reference: payload.entityId, issuedOn: 'today' },
    };
  },
  saveKey(_tx, payload, key) {
    savedKeys.push({ entityId: payload.entityId, key });
    return Promise.resolve();
  },
};
const peekKind: PdfKindHandler = {
  kind: 'peek',
  template: 'sample',
  async load(tx, payload) {
    // entityId names ANOTHER tenant: under Row Level Security it simply does not exist for this job
    const other = await tx.tenant.findUnique({ where: { id: payload.entityId } });
    if (!other) return null;
    return { locale: 'en', vars: { tenantName: other.name, reference: 'x', issuedOn: 'x' } };
  },
};
const brokenKind: PdfKindHandler = {
  kind: 'broken',
  template: 'does-not-exist',
  load: () => Promise.resolve({ locale: 'en', vars: {} }),
};

describe('pdf.render', () => {
  let fx: Fixture;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    // Fast retries: two retries one second apart (production: 30 s backoff, capped at 1 h, 5 retries).
    fx = await createFixture({ retryLimit: 2, retryDelaySeconds: 1, retryBackoff: false });
    tenantId = await createTenant(fx.tenantDb, 'Royal Hall رائل ہال');
    otherTenantId = await createTenant(fx.tenantDb, 'Other Tenant Secret Name');
    await ensureTestBucket();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const enqueue = (payload: PdfRenderPayload, tenant = payload.tenantId) =>
    fx.tenantDb.tx({ tenantId: tenant }, (tx) =>
      fx.queue.send(tx, JOB_NAMES.PDF_RENDER, payload, {
        singletonKey: `${payload.kind}:${payload.entityId}:${Math.random()}`,
      }),
    );

  const outcome = (payload: PdfRenderPayload) =>
    eventually(
      async () => {
        const jobs = await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
          key: 'entityId',
          value: payload.entityId,
        });
        const done = jobs.find((j) => ['completed', 'failed'].includes(j.state));
        if (!done) return undefined;
        const dead = await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER_DEAD, {
          key: 'entityId',
          value: payload.entityId,
        });
        return { job: done, deadLettered: dead.length > 0 };
      },
      { timeoutMs: 60_000, what: `pdf.render ${payload.entityId}` },
    );

  async function withWorker<T>(
    options: Parameters<typeof startWorker>[0],
    fn: (worker: RunningWorker) => Promise<T>,
  ): Promise<T> {
    const worker = await startWorker(options);
    try {
      return await fn(worker);
    } finally {
      await worker.stop();
    }
  }

  it('renders the sample with real Chromium, stores it in S3 under the tenant prefix and returns the key', async () => {
    const payload = { tenantId, kind: 'sample', entityId: `ok-${Date.now()}` };
    await withWorker({}, async (worker) => {
      await enqueue(payload);
      const { job, deadLettered } = await outcome(payload);
      expect(deadLettered).toBe(false);
      expect(job.state).toBe('completed');
      const key = pdfObjectKey(tenantId, 'sample', payload.entityId);
      expect(job.output).toMatchObject({ key });
      expect(key).toMatch(/^tenants\/[^/]+\/pdf\/sample\/[^/]+\.pdf$/);
      expect(key).not.toMatch(/^[a-z]+:\/\//); // a key, never a URL

      const s3 = testS3();
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: TEST_BUCKET, Key: key }));
        expect(object.ContentType).toBe('application/pdf');
        const bytes = Buffer.from(await object.Body!.transformToByteArray());
        expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
        expect(bytes.length).toBe((job.output as { bytes: number }).bytes);
        // the bundled font was embedded
        const raw = bytes.toString('latin1');
        expect(raw).toContain('NotoSans');

        // running it again (a retry, a second delivery) overwrites the same object: still exactly one
        await enqueue(payload);
        await eventually(
          async () => {
            const jobs = await jobsOfQueue(fx.admin, JOB_NAMES.PDF_RENDER, {
              key: 'entityId',
              value: payload.entityId,
            });
            return jobs.length === 2 && jobs.every((j) => j.state === 'completed')
              ? true
              : undefined;
          },
          { what: 'the second run' },
        );
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: TEST_BUCKET,
            Prefix: `tenants/${tenantId}/pdf/sample/${payload.entityId}`,
          }),
        );
        expect(listed.KeyCount).toBe(1);
      } finally {
        s3.destroy();
      }
      expect(worker.rawLogs()).not.toContain('Royal Hall');
      expect(worker.rawLogs()).not.toContain('رائل');
    });
  });

  it('hands the key (not a URL) to the kind after the upload, in the tenant it belongs to', async () => {
    const storage = new ScriptedStorage();
    const renderer = new ScriptedRenderer(() => FAKE_PDF);
    const payload = { tenantId, kind: 'keyed', entityId: `keyed-${Date.now()}` };
    await withWorker({ renderer, storage, kinds: [keyedKind] }, async () => {
      await enqueue(payload);
      const { job } = await outcome(payload);
      expect(job.state).toBe('completed');
    });
    const expected = `tenants/${tenantId}/pdf/keyed/${payload.entityId}.pdf`;
    expect(storage.puts).toEqual([
      { key: expected, bytes: FAKE_PDF.length, contentType: 'application/pdf' },
    ]);
    expect(savedKeys).toContainEqual({ entityId: payload.entityId, key: expected });
    expect(savedKeys.every((s) => !/^[a-z]+:\/\//.test(s.key))).toBe(true);
  });

  describe('permanent failures dead-letter at once, without retries and without touching S3', () => {
    const cases: [string, PdfRenderPayload | Record<string, unknown>, string][] = [
      [
        'an unknown kind',
        { tenantId: '', kind: 'invoice', entityId: 'unknown-kind' },
        'UNKNOWN_KIND',
      ],
      [
        'an entity that does not exist',
        { tenantId: 'ghost-tenant', kind: 'sample', entityId: 'ghost' },
        'ENTITY_NOT_FOUND',
      ],
      [
        "another tenant's entity (Row Level Security)",
        { tenantId: '', kind: 'peek', entityId: '' },
        'ENTITY_NOT_FOUND',
      ],
      [
        'a template that does not exist',
        { tenantId: '', kind: 'broken', entityId: 'broken-template' },
        'TEMPLATE_ERROR',
      ],
    ];
    for (const [name, base, code] of cases) {
      it(`${name}: ${code}`, async () => {
        const entityId = base.entityId
          ? String(base.entityId)
          : `${code.toLowerCase()}-${Date.now()}`;
        const payload = {
          ...base,
          tenantId: base.tenantId || tenantId,
          entityId: base.kind === 'peek' ? otherTenantId : entityId,
        } as PdfRenderPayload;
        const storage = new ScriptedStorage();
        const renderer = new ScriptedRenderer(() => FAKE_PDF);
        await withWorker({ renderer, storage, kinds: [peekKind, brokenKind] }, async () => {
          await enqueue(payload);
          const { job, deadLettered } = await outcome(payload);
          expect(job).toMatchObject({ state: 'failed', retry_count: 0, output: { code } });
          expect(deadLettered).toBe(true);
        });
        expect(storage.puts).toEqual([]);
        expect(renderer.calls).toBe(0);
      });
    }

    it('a payload with extra keys is INVALID_PAYLOAD (customer data cannot ride along)', async () => {
      const entityId = `extra-${Date.now()}`;
      await withWorker({}, async (worker) => {
        // straight into the queue, past the Zod check of JobQueue.send (which would refuse it)
        await worker.get<PgBossService>(PgBossService).boss.send(JOB_NAMES.PDF_RENDER, {
          tenantId,
          kind: 'sample',
          entityId,
          customerName: 'Ali Khan',
        });
        const { job, deadLettered } = await outcome({ tenantId, kind: 'sample', entityId });
        expect(job.output).toMatchObject({ code: 'INVALID_PAYLOAD' });
        expect(deadLettered).toBe(true);
        expect(worker.rawLogs()).not.toContain('Ali Khan');
      });
    });

    it('a PDF over the size limit is TOO_LARGE and is never uploaded', async () => {
      const storage = new ScriptedStorage();
      const renderer = new ScriptedRenderer(() => Buffer.alloc(PDF_MAX_BYTES + 1));
      const payload = { tenantId, kind: 'sample', entityId: `big-${Date.now()}` };
      await withWorker({ renderer, storage }, async () => {
        await enqueue(payload);
        const { job, deadLettered } = await outcome(payload);
        expect(job.output).toMatchObject({ code: 'TOO_LARGE' });
        expect(job.retry_count).toBe(0);
        expect(deadLettered).toBe(true);
      });
      expect(storage.puts).toEqual([]);
    });
  });

  describe('transient failures are retried, then dead-lettered', () => {
    it('a renderer that keeps timing out: 3 attempts, then dead letter with RENDER_TIMEOUT', async () => {
      const renderer = new ScriptedRenderer(() => new PdfRenderError('RENDER_TIMEOUT'));
      const storage = new ScriptedStorage();
      const payload = { tenantId, kind: 'sample', entityId: `timeout-${Date.now()}` };
      await withWorker({ renderer, storage }, async () => {
        await enqueue(payload);
        const { job, deadLettered } = await outcome(payload);
        expect(job).toMatchObject({
          state: 'failed',
          retry_count: 2,
          output: { code: 'RENDER_TIMEOUT' },
        });
        expect(deadLettered).toBe(true);
      });
      expect(renderer.calls).toBe(3);
      expect(storage.puts).toEqual([]);
    });

    it('storage that fails once: the retry stores the PDF and the job completes', async () => {
      const renderer = new ScriptedRenderer(() => FAKE_PDF);
      const storage = new ScriptedStorage(1);
      const payload = { tenantId, kind: 'sample', entityId: `flaky-${Date.now()}` };
      await withWorker({ renderer, storage }, async () => {
        await enqueue(payload);
        const { job, deadLettered } = await outcome(payload);
        expect(job).toMatchObject({ state: 'completed', retry_count: 1 });
        expect(deadLettered).toBe(false);
      });
      expect(storage.attempts).toBe(2);
      expect(storage.puts).toHaveLength(1);
    });

    it('a browser that cannot start is retried like any transient failure and logs a code only', async () => {
      const renderer = new ScriptedRenderer(() => new PdfRenderError('BROWSER_UNAVAILABLE'));
      const payload = { tenantId, kind: 'sample', entityId: `nobrowser-${Date.now()}` };
      await withWorker({ renderer, storage: new ScriptedStorage() }, async (worker) => {
        await enqueue(payload);
        const { job } = await outcome(payload);
        expect(job.output).toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
        expect(worker.rawLogs()).toContain('BROWSER_UNAVAILABLE');
      });
    });
  });
});

describe('object keys', () => {
  it('accepts only tenants/{tenantId}/... and refuses traversal', () => {
    expect(() => assertTenantObjectKey('tenants/t1/pdf/sample/a.pdf', 't1')).not.toThrow();
    for (const bad of [
      'tenants/t2/pdf/a.pdf', // another tenant
      'tenants/t1/../t2/a.pdf',
      '/tenants/t1/a.pdf',
      'tenants/t1//a.pdf',
      'tenants/t1/',
      'https://bucket.s3.amazonaws.com/tenants/t1/a.pdf',
      'other/t1/a.pdf',
    ]) {
      expect(() => assertTenantObjectKey(bad, 't1'), bad).toThrow();
    }
  });
});
