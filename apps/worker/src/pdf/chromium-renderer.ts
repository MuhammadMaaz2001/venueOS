import { chromium, errors } from 'playwright';
import type { Browser } from 'playwright';
import type { WorkerConfig } from '../config/config.module';
import type { Logger } from '../logging/logging.module';

/** Injection token for the PDF renderer. Tests override it with a scripted one. */
export const PDF_RENDERER = Symbol('PDF_RENDERER');

export type PdfRenderErrorCode = 'RENDER_TIMEOUT' | 'BROWSER_UNAVAILABLE';

/** The render failed. `code` is a fixed code; Playwright's text (paths, URLs) is never kept. */
export class PdfRenderError extends Error {
  constructor(readonly code: PdfRenderErrorCode) {
    super(code);
    this.name = 'PdfRenderError';
  }
}

export interface PdfRenderer {
  /** Turn one self-contained HTML document into a PDF (A4 or the page size the CSS asks for). */
  render(html: string): Promise<Buffer>;
}

/**
 * Headless Chromium through Playwright, one shared browser for the whole worker.
 *
 * - The browser starts on the first render and is started again if it ever disconnects (crash, OOM kill).
 * - Every render gets its own context and page, closed afterwards: nothing is shared between documents.
 * - The page is locked down: JavaScript is off, service workers and downloads are blocked, and EVERY network
 *   request is aborted. A document is a string with its fonts inlined as data: URLs, so nothing legitimate
 *   needs the network, and a template that tried (by mistake or by injection) cannot reach a metadata
 *   endpoint, an internal service or a file (SSRF, docs/04 section 4).
 * - At most `PDF_CONCURRENCY` pages are open at once; the rest wait their turn.
 */
export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | undefined;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      'PDF_CONCURRENCY' | 'PDF_RENDER_TIMEOUT_MS' | 'PDF_CHROMIUM_PATH'
    >,
    private readonly logger: Logger,
  ) {}

  async render(html: string): Promise<Buffer> {
    await this.acquire();
    try {
      return await this.renderOne(html);
    } finally {
      this.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.browser;
    this.browser = undefined;
    if (pending) await pending.then((b) => b.close()).catch(() => undefined);
  }

  private async renderOne(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const timeout = this.config.PDF_RENDER_TIMEOUT_MS;
    let context;
    try {
      context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
        offline: true,
      });
    } catch {
      this.forgetBrowser();
      throw new PdfRenderError('BROWSER_UNAVAILABLE');
    }
    try {
      // Allow nothing but the data: URLs the document inlines. (Playwright does not route data: requests
      // through here at all; anything that does arrive is a real network or file request and is dropped.)
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      return Buffer.from(pdf);
    } catch (error) {
      if (error instanceof errors.TimeoutError) throw new PdfRenderError('RENDER_TIMEOUT');
      if (!browser.isConnected()) this.forgetBrowser();
      throw new PdfRenderError('BROWSER_UNAVAILABLE');
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private getBrowser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new PdfRenderError('BROWSER_UNAVAILABLE'));
    this.browser ??= chromium
      .launch({
        headless: true,
        ...(this.config.PDF_CHROMIUM_PATH ? { executablePath: this.config.PDF_CHROMIUM_PATH } : {}),
        // /dev/shm is tiny in containers; Chromium falls back to /tmp.
        args: ['--disable-dev-shm-usage'],
        timeout: 30_000,
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          if (this.closed) return;
          this.logger.warn('chromium disconnected, it will be started again on the next render');
          this.forgetBrowser();
        });
        this.logger.info('chromium started');
        return browser;
      })
      .catch(() => {
        this.browser = undefined;
        throw new PdfRenderError('BROWSER_UNAVAILABLE');
      });
    return this.browser;
  }

  private forgetBrowser(): void {
    this.browser = undefined;
  }

  private async acquire(): Promise<void> {
    if (this.running < this.config.PDF_CONCURRENCY) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next)
      next(); // hand the slot over: `running` stays the same
    else this.running -= 1;
  }
}
