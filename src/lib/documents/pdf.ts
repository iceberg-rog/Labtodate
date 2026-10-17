import type { Browser } from 'puppeteer-core';

/**
 * Server-side HTML → PDF with headless Chromium (puppeteer-core; no bundled
 * browser download). The executable comes from CHROMIUM_PATH — /usr/bin/chromium
 * in the Docker image (Debian `chromium` package), the Playwright headless shell
 * locally.
 *
 *  - ONE browser per server process, launched lazily and reused (stored on
 *    globalThis so route handlers and server actions share it); relaunched if it
 *    dies.
 *  - Each render gets its own page, closed afterwards; at most MAX_CONCURRENT
 *    renders at a time (memory-bounded container).
 *  - JavaScript disabled and every network request blocked: documents are
 *    self-contained HTML (inline CSS, data: logo), so nothing can be fetched.
 *  - Hard time limit per render; on timeout the browser is recycled.
 *  - Failures throw PdfRenderError — callers degrade gracefully (email goes out
 *    with a link, download route answers with a readable 503).
 */

export class PdfRenderError extends Error {}

const RENDER_TIMEOUT_MS = 25_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;

type PdfState = {
  browser: Promise<Browser> | null;
  active: number;
  queue: Array<() => void>;
};

const g = globalThis as unknown as { __l2dPdf?: PdfState };
const state: PdfState = (g.__l2dPdf ??= { browser: null, active: 0, queue: [] });

export function chromiumPath(): string {
  return (process.env.CHROMIUM_PATH || '').trim() || '/usr/bin/chromium';
}

async function launch(): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  const executablePath = chromiumPath();
  const browser = await puppeteer.launch({
    executablePath,
    // The Chrome-for-Testing "headless shell" binary only runs in shell mode;
    // the full Chromium (Docker) uses the new headless mode.
    headless: /headless[-_]shell/i.test(executablePath) ? 'shell' : true,
    timeout: LAUNCH_TIMEOUT_MS,
    args: [
      '--no-sandbox', // runs as an unprivileged user in a container without user namespaces
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Docker's 64 MB /dev/shm is too small for Chromium
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--font-render-hinting=none',
    ],
  });
  browser.on('disconnected', () => {
    state.browser = null;
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (state.browser) {
    const b = await state.browser.catch(() => null);
    if (b && b.connected) return b;
    state.browser = null;
  }
  const p = launch();
  state.browser = p;
  try {
    return await p;
  } catch (e) {
    state.browser = null;
    throw e;
  }
}

async function recycleBrowser(): Promise<void> {
  const p = state.browser;
  state.browser = null;
  const b = await p?.catch(() => null);
  if (b) {
    try { b.process()?.kill('SIGKILL'); } catch { /* already gone */ }
    await b.close().catch(() => {});
  }
}

/** Shut the shared browser down (scripts / tests, so the process can exit). */
export async function closePdfBrowser(): Promise<void> {
  await recycleBrowser();
}

async function acquire(): Promise<void> {
  if (state.active < MAX_CONCURRENT) {
    state.active++;
    return;
  }
  await new Promise<void>((resolve) => state.queue.push(resolve));
  state.active++;
}

function release(): void {
  state.active--;
  const next = state.queue.shift();
  if (next) next();
}

/** "Page {PAGE} of {PAGES}" → Chromium's footer template (pageNumber / totalPages spans). */
function pageTemplate(label: string): string {
  const safe = label.replace(/[<>&"]/g, '');
  return safe.replace('{PAGE}', '<span class="pageNumber"></span>').replace('{PAGES}', '<span class="totalPages"></span>');
}

/** Number of pages of a Chromium-printed PDF (page objects in the file). */
export function pdfPageCount(pdf: Buffer): number {
  const m = pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

async function renderOnce(html: string, footerText: string, pageLabel: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') req.continue().catch(() => {});
      else req.abort('blockedbyclient').catch(() => {});
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    await page.emulateMediaType('print');
    const footer = `<div style="width:100%;font-size:7px;color:#9ca3af;padding:0 14mm;display:flex;justify-content:space-between;font-family:Arial,'DejaVu Sans',sans-serif;">
      <span>${footerText.replace(/[<>&"]/g, '')}</span>
      <span>${pageTemplate(pageLabel)}</span>
    </div>`;
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      timeout: 20_000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Render a self-contained HTML document to an A4 PDF. Throws PdfRenderError. */
export async function htmlToPdf(html: string, opts: { footerText?: string; pageLabel?: string } = {}): Promise<Buffer> {
  await acquire();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      renderOnce(html, opts.footerText ?? '', opts.pageLabel || 'Page {PAGE} of {PAGES}'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PdfRenderError(`PDF rendering timed out after ${RENDER_TIMEOUT_MS / 1000}s`)), RENDER_TIMEOUT_MS);
      }),
    ]);
    if (result.length < 100 || result.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new PdfRenderError('Chromium returned something that is not a PDF');
    }
    return result;
  } catch (e) {
    if (e instanceof PdfRenderError && /timed out/.test(e.message)) await recycleBrowser();
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pdf] render failed (CHROMIUM_PATH=${chromiumPath()}):`, msg);
    throw e instanceof PdfRenderError ? e : new PdfRenderError(msg);
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}
