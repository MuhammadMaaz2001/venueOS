// Renders the bilingual sample document with the worker's real Chromium renderer and writes the PDF.
//
//   pnpm --filter @venueos/worker pdf:sample [outFile]      (default: apps/worker/.artifacts/sample.pdf)
//
// Needs Playwright's Chromium (`pnpm --filter @venueos/worker exec playwright install chromium`) and a built
// worker (the script builds it first). No database, no S3: it only exercises template + fonts + Chromium, so it
// is the quickest way to look at a layout change or to check a new machine or container image.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderPdfHtml } = require('@venueos/templates');
const { ChromiumPdfRenderer } = require('../dist/pdf/chromium-renderer.js');

const out = path.resolve(process.argv[2] ?? path.join(here, '..', '.artifacts', 'sample.pdf'));
const logger = { info: () => undefined, warn: console.warn, error: console.error };
const renderer = new ChromiumPdfRenderer(
  {
    PDF_CONCURRENCY: 1,
    PDF_RENDER_TIMEOUT_MS: 30_000,
    PDF_CHROMIUM_PATH: process.env.PDF_CHROMIUM_PATH,
  },
  logger,
);

try {
  const { html } = renderPdfHtml('sample', 'en', {
    tenantName: 'Royal Hall',
    reference: 'SAMPLE-0001',
    issuedOn: new Date().toISOString().slice(0, 10),
  });
  const started = Date.now();
  const pdf = await renderer.render(html);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, pdf);
  console.log(`wrote ${out} (${pdf.length} bytes, ${Date.now() - started} ms)`);
} finally {
  await renderer.close();
}
