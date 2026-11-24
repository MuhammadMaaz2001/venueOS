import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPdfHtml } from '@venueos/templates';
import { ChromiumPdfRenderer, PdfRenderError } from '../pdf/chromium-renderer';
import type { Logger } from '../logging/logging.module';

// The real headless Chromium (Playwright). No database, no S3.
// Needs the browser: pnpm --filter @venueos/worker exec playwright install chromium

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

describe('ChromiumPdfRenderer', () => {
  let server: http.Server;
  let origin: string;
  const hits: string[] = [];
  let renderer: ChromiumPdfRenderer;

  const make = (
    overrides: Partial<{ PDF_CONCURRENCY: number; PDF_RENDER_TIMEOUT_MS: number }> = {},
  ) =>
    new ChromiumPdfRenderer(
      {
        PDF_CONCURRENCY: 2,
        PDF_RENDER_TIMEOUT_MS: 30_000,
        PDF_CHROMIUM_PATH: undefined,
        ...overrides,
      },
      silent,
    );

  beforeAll(async () => {
    // A stand-in for "an internal service or a metadata endpoint": it must never be asked anything.
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('internal');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    renderer = make();
  });
  afterAll(async () => {
    await renderer.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('renders the bilingual sample into a PDF with the bundled fonts embedded', async () => {
    const { html } = renderPdfHtml('sample', 'ur', {
      tenantName: 'رائل ہال',
      reference: 'R-1',
      issuedOn: '2026-11-25',
    });
    const pdf = await renderer.render(html);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-16).toString()).toContain('%%EOF');
    const raw = pdf.toString('latin1');
    for (const font of ['NotoNastaliqUrdu', 'NotoNaskhArabic', 'NotoSans']) {
      expect(raw, font).toContain(font);
    }
    // one A4 page
    expect(raw.match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  });

  it('never touches the network: images, stylesheets, frames, fetches and scripts are all dead', async () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="${origin}/style.css">
      <script src="${origin}/script.js"></script>
      <script>fetch('${origin}/fetch')</script>
      </head><body>
      <img src="${origin}/image.png">
      <iframe src="${origin}/frame"></iframe>
      <object data="${origin}/object"></object>
      <div style="background:url(${origin}/bg.png)">x</div>
      </body></html>`;
    const pdf = await renderer.render(html);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // give a late request every chance to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hits).toEqual([]);
  });

  it('answers a page that cannot finish in time with RENDER_TIMEOUT (retryable)', async () => {
    const slow = make({ PDF_RENDER_TIMEOUT_MS: 1000 });
    try {
      // hundreds of thousands of table cells: layout takes longer than a second
      const rows = '<tr>' + '<td>x</td>'.repeat(60) + '</tr>';
      const html = `<!doctype html><body><table>${rows.repeat(6000)}</table></body>`;
      await expect(slow.render(html)).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' });
    } finally {
      await slow.close();
    }
  });

  it('renders several documents at once, at most PDF_CONCURRENCY at a time, and all succeed', async () => {
    const one = make({ PDF_CONCURRENCY: 1 });
    try {
      const { html } = renderPdfHtml('sample', 'en', {
        tenantName: 'Hall',
        reference: 'R',
        issuedOn: '2026-11-25',
      });
      const pdfs = await Promise.all([one.render(html), one.render(html), one.render(html)]);
      expect(pdfs.every((p) => p.subarray(0, 5).toString() === '%PDF-')).toBe(true);
    } finally {
      await one.close();
    }
  });

  it('starts a new browser after the old one died', async () => {
    const r = make();
    try {
      const html = '<!doctype html><body>hello</body>';
      await r.render(html);
      // kill the shared browser behind the renderer's back
      const browser = await (r as unknown as { browser: Promise<{ close(): Promise<void> }> })
        .browser;
      await browser.close();
      const pdf = await r.render(html);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      await r.close();
    }
  });

  it('refuses work after close, with a fixed code', async () => {
    const r = make();
    await r.close();
    await expect(r.render('<p>x</p>')).rejects.toBeInstanceOf(PdfRenderError);
  });
});
