import {
  ExtractedProduct,
  ExtractionAttempt,
  extractWoo,
  extractShopify,
  fetchHtml,
  extractJsonLd,
  extractOpenGraph,
  extractWithAi,
} from './extractors';
import { SafeFetchError } from './safe-fetch';

export interface ImportRunResult {
  ok: boolean;
  url: string;
  finalUrl: string | null;
  platform: ExtractionAttempt['platform'];
  confidence: ExtractionAttempt['confidence'];
  product: ExtractedProduct | null;
  attempts: Array<{
    platform: ExtractionAttempt['platform'];
    outcome: 'matched' | 'skipped' | 'error';
    note?: string;
  }>;
  warnings: string[];
  error?: string;
}

/**
 * Run the full pipeline against a single URL. Stops at the first extractor
 * that produces a usable product. Always returns — never throws — so the
 * server action can return a clean JSON envelope.
 */
export async function runImport(rawUrl: string): Promise<ImportRunResult> {
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    return basicFail(rawUrl, 'Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return basicFail(rawUrl, `Disallowed scheme ${url.protocol}.`);
  }

  const attempts: ImportRunResult['attempts'] = [];

  // 1. WooCommerce
  const woo = await extractWoo(url);
  if (woo.product) return success(rawUrl, url.toString(), woo, attempts.concat({ platform: 'woo', outcome: 'matched' }));
  attempts.push({ platform: 'woo', outcome: woo.error ? 'skipped' : 'skipped', note: woo.error });

  // 2. Shopify
  const sh = await extractShopify(url);
  if (sh.product) return success(rawUrl, url.toString(), sh, attempts.concat({ platform: 'shopify', outcome: 'matched' }));
  attempts.push({ platform: 'shopify', outcome: 'skipped', note: sh.error });

  // 3 + 4 + 5. Need the HTML
  const page = await fetchHtml(url);
  if ('error' in page) {
    return basicFail(rawUrl, `Could not fetch page HTML: ${page.error}`, attempts);
  }

  // 3. JSON-LD
  const ld = extractJsonLd(page.html);
  if (ld.product) return success(rawUrl, page.finalUrl, ld, attempts.concat({ platform: 'json-ld', outcome: 'matched' }));
  attempts.push({ platform: 'json-ld', outcome: 'skipped' });

  // 4. OpenGraph
  const og = extractOpenGraph(page.html, page.finalUrl);
  if (og.product) return success(rawUrl, page.finalUrl, og, attempts.concat({ platform: 'opengraph', outcome: 'matched' }));
  attempts.push({ platform: 'opengraph', outcome: 'skipped' });

  // 5. AI fallback (slow + costs an API call — only when nothing else worked)
  const ai = await extractWithAi(page.html, page.finalUrl);
  if (ai.product) return success(rawUrl, page.finalUrl, ai, attempts.concat({ platform: 'ai-fallback', outcome: 'matched' }));
  attempts.push({ platform: 'ai-fallback', outcome: 'error', note: ai.error });

  return {
    ok: false,
    url: rawUrl,
    finalUrl: page.finalUrl,
    platform: 'unknown',
    confidence: 'low',
    product: null,
    attempts,
    warnings: [],
    error: ai.error === 'AI: not a product page'
      ? 'This page does not look like a product page (might be a homepage, article, or category list).'
      : 'No structured product data could be extracted from this page.',
  };
}

function success(rawUrl: string, finalUrl: string, a: ExtractionAttempt, attempts: ImportRunResult['attempts']): ImportRunResult {
  return {
    ok: true,
    url: rawUrl,
    finalUrl,
    platform: a.platform,
    confidence: a.confidence,
    product: a.product,
    attempts,
    warnings: a.product?.warnings ?? [],
  };
}

function basicFail(rawUrl: string, message: string, attempts: ImportRunResult['attempts'] = []): ImportRunResult {
  return {
    ok: false,
    url: rawUrl,
    finalUrl: null,
    platform: 'unknown',
    confidence: 'low',
    product: null,
    attempts,
    warnings: [],
    error: message,
  };
}

export { SafeFetchError };
