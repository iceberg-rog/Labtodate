/**
 * Platform extractors for the URL importer pipeline.
 *
 * The orchestrator (./run.ts) tries each path in order and stops at the
 * first one that yields a usable product. Each extractor returns null when
 * its signal isn't present so the next one gets a turn.
 *
 *   1. extractWoo         — /wp-json/wc/store/v1/products?slug=…
 *   2. extractShopify     — /products/<slug>.json
 *   3. extractJsonLd      — <script type="application/ld+json"> Product schema
 *   4. extractOpenGraph   — <meta property="og:…">  + product:price:amount
 *   5. extractWithAi      — last-ditch HTML → JSON via Claude
 */

import { safeFetch, SafeFetchError } from './safe-fetch';

export interface ExtractedProduct {
  title: string;
  summary?: string | null;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  condition?: 'NEW' | 'REFURBISHED' | 'USED' | null;
  priceCents: number | null;
  currency: string;
  images: string[];
  specs: Record<string, string>;
  availability?: string | null;
  warnings: string[];
}

export interface ExtractionAttempt {
  platform: 'woo' | 'shopify' | 'json-ld' | 'opengraph' | 'ai-fallback' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  product: ExtractedProduct | null;
  /** Whatever failed for diagnostic display, never thrown */
  error?: string;
}

const CURRENCY_FALLBACK = 'EUR';

function clean(s: string | null | undefined, max = 8000): string | null {
  if (!s) return null;
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length ? trimmed.slice(0, max) : null;
}

function stripHtml(h: string): string {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function priceCentsFrom(value: unknown): number | null {
  if (value == null) return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(/(\d),(\d{3})/g, '$1$2').replace(',', '.');
    n = parseFloat(cleaned);
  } else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. WooCommerce
// ─────────────────────────────────────────────────────────────────────────

interface WooStoreV1Product {
  id: number;
  name: string;
  slug: string;
  short_description: string;
  description: string;
  prices: { price: string; currency_code: string };
  images: { src: string }[];
  categories: { name: string }[];
  attributes?: { name: string; terms: { name: string }[] }[];
}

export async function extractWoo(url: URL): Promise<ExtractionAttempt> {
  // Best-effort slug detection: take last non-empty path segment.
  const segs = url.pathname.split('/').filter(Boolean);
  const slug = segs[segs.length - 1];
  if (!slug) return { platform: 'woo', confidence: 'high', product: null, error: 'no slug in path' };
  const probeUrl = `${url.protocol}//${url.host}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}&per_page=1`;
  try {
    const res = await safeFetch(probeUrl, { accept: 'application/json' });
    if (!/json/i.test(res.contentType)) return { platform: 'woo', confidence: 'high', product: null };
    const arr = JSON.parse(res.body) as WooStoreV1Product[];
    if (!Array.isArray(arr) || arr.length === 0) return { platform: 'woo', confidence: 'high', product: null };
    const w = arr[0];
    const specs: Record<string, string> = {};
    for (const a of w.attributes ?? []) {
      if (a.name && a.terms?.length) specs[a.name.slice(0, 80)] = a.terms.map((t) => t.name).join(', ').slice(0, 200);
    }
    return {
      platform: 'woo',
      confidence: 'high',
      product: {
        title: stripHtml(w.name).slice(0, 200),
        summary: clean(stripHtml(w.short_description), 280),
        description: clean(stripHtml(w.short_description || w.description), 8000),
        brand: w.categories?.[0]?.name ?? null,
        condition: null,
        priceCents: priceCentsFrom(w.prices?.price),
        currency: w.prices?.currency_code || CURRENCY_FALLBACK,
        images: (w.images ?? []).map((i) => i.src).filter(Boolean).slice(0, 8),
        specs,
        warnings: [],
      },
    };
  } catch (e) {
    return { platform: 'woo', confidence: 'high', product: null, error: e instanceof SafeFetchError ? e.code : e instanceof Error ? e.message : 'unknown' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Shopify
// ─────────────────────────────────────────────────────────────────────────

interface ShopifyProductJson {
  product?: {
    id: number;
    title: string;
    body_html: string;
    vendor: string;
    product_type?: string;
    images: { src: string }[];
    variants: { price: string; compare_at_price?: string | null; available?: boolean }[];
    tags?: string[];
  };
}

export async function extractShopify(url: URL): Promise<ExtractionAttempt> {
  // Shopify exposes JSON at <url>.json (works for the product detail URL).
  const probeUrl = url.toString().replace(/\?.*$/, '').replace(/\/$/, '') + '.json';
  try {
    const res = await safeFetch(probeUrl, { accept: 'application/json' });
    if (!/json/i.test(res.contentType)) return { platform: 'shopify', confidence: 'high', product: null };
    const data = JSON.parse(res.body) as ShopifyProductJson;
    const p = data.product;
    if (!p?.title) return { platform: 'shopify', confidence: 'high', product: null };
    const variant = p.variants?.[0];
    const specs: Record<string, string> = {};
    if (p.product_type) specs['Type'] = p.product_type;
    if (p.tags?.length) specs['Tags'] = p.tags.join(', ').slice(0, 200);
    return {
      platform: 'shopify',
      confidence: 'high',
      product: {
        title: stripHtml(p.title).slice(0, 200),
        summary: null,
        description: clean(stripHtml(p.body_html), 8000),
        brand: p.vendor ?? null,
        condition: null,
        priceCents: priceCentsFrom(variant?.price),
        currency: CURRENCY_FALLBACK,    // /products/<slug>.json doesn't return currency
        images: (p.images ?? []).map((i) => i.src).filter(Boolean).slice(0, 8),
        specs,
        availability: variant?.available ? 'in_stock' : 'out_of_stock',
        warnings: ['Shopify .json endpoint does not return currency — defaulting to EUR. Edit before publishing if needed.'],
      },
    };
  } catch (e) {
    return { platform: 'shopify', confidence: 'high', product: null, error: e instanceof SafeFetchError ? e.code : e instanceof Error ? e.message : 'unknown' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3 + 4. HTML-scoped: JSON-LD + OpenGraph share one fetch.
// ─────────────────────────────────────────────────────────────────────────

interface HtmlPage {
  html: string;
  finalUrl: string;
}

export async function fetchHtml(url: URL): Promise<HtmlPage | { error: string }> {
  try {
    const res = await safeFetch(url.toString(), { accept: 'text/html,application/xhtml+xml' });
    if (!/html/i.test(res.contentType) && !res.body.startsWith('<')) {
      return { error: `Not HTML (content-type=${res.contentType || 'unknown'}).` };
    }
    return { html: res.body, finalUrl: res.finalUrl };
  } catch (e) {
    return { error: e instanceof SafeFetchError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : 'unknown' };
  }
}

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  image?: string | string[];
  brand?: string | { name?: string };
  offers?: {
    price?: string | number;
    priceCurrency?: string;
    availability?: string;
  } | Array<{ price?: string | number; priceCurrency?: string; availability?: string }>;
  sku?: string;
  mpn?: string;
  category?: string;
}

function flattenJsonLdGraph(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  out.push(obj);
  if (Array.isArray(obj['@graph'])) {
    for (const n of obj['@graph']) flattenJsonLdGraph(n, out);
  }
  return out;
}

export function extractJsonLd(html: string): ExtractionAttempt {
  const blocks = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  if (!blocks.length) return { platform: 'json-ld', confidence: 'high', product: null };
  for (const m of blocks) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(parsed) ? parsed.flatMap((n) => flattenJsonLdGraph(n)) : flattenJsonLdGraph(parsed);
    for (const raw of nodes) {
      const node = raw as JsonLdProduct;
      const typeRaw = node['@type'];
      const types = Array.isArray(typeRaw) ? typeRaw : typeRaw ? [typeRaw] : [];
      if (!types.some((t) => /Product/i.test(t))) continue;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const imageArr = Array.isArray(node.image) ? node.image : node.image ? [node.image] : [];
      return {
        platform: 'json-ld',
        confidence: 'high',
        product: {
          title: clean(stripHtml(node.name ?? ''), 200) ?? '',
          summary: null,
          description: clean(stripHtml(node.description ?? '')),
          brand: typeof node.brand === 'string' ? node.brand : node.brand?.name ?? null,
          condition: null,
          priceCents: priceCentsFrom(offer?.price),
          currency: offer?.priceCurrency || CURRENCY_FALLBACK,
          images: imageArr.filter(Boolean).slice(0, 8),
          specs: node.sku ? { SKU: String(node.sku).slice(0, 80) } : {},
          availability: offer?.availability ?? null,
          warnings: [],
        },
      };
    }
  }
  return { platform: 'json-ld', confidence: 'high', product: null };
}

export function extractOpenGraph(html: string, fallbackUrl: string): ExtractionAttempt {
  const meta = new Map<string, string>();
  const re = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  for (const m of html.matchAll(re)) meta.set(m[1].toLowerCase(), m[2]);
  const altRe = /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  for (const m of html.matchAll(altRe)) {
    const k = m[2].toLowerCase();
    if (!meta.has(k)) meta.set(k, m[1]);
  }
  const title = meta.get('og:title') || meta.get('twitter:title');
  if (!title) return { platform: 'opengraph', confidence: 'medium', product: null };
  const price = meta.get('product:price:amount') || meta.get('og:price:amount') || meta.get('twitter:data1');
  const currency = meta.get('product:price:currency') || meta.get('og:price:currency') || CURRENCY_FALLBACK;
  const description = meta.get('og:description') || meta.get('twitter:description') || meta.get('description');
  const image = meta.get('og:image') || meta.get('twitter:image');
  const isProductOg = (meta.get('og:type') ?? '').toLowerCase().includes('product');
  const warnings = isProductOg ? [] : ['OpenGraph type is not product — extracted optimistically. Verify before publishing.'];
  if (price) warnings.push('Price extracted from OG meta — verify against the source page.');
  return {
    platform: 'opengraph',
    confidence: 'medium',
    product: {
      title: clean(title, 200) ?? title.slice(0, 200),
      summary: clean(description, 280),
      description: clean(description),
      brand: meta.get('product:brand') || null,
      condition: null,
      priceCents: price ? priceCentsFrom(price) : null,
      currency,
      images: image ? [new URL(image, fallbackUrl).toString()] : [],
      specs: {},
      warnings,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. AI fallback — only fires when 1-4 all returned null.
// ─────────────────────────────────────────────────────────────────────────

export async function extractWithAi(html: string, finalUrl: string): Promise<ExtractionAttempt> {
  const cleaned = stripHtml(html).slice(0, 16000); // bound prompt size
  if (cleaned.length < 80) {
    return { platform: 'ai-fallback', confidence: 'low', product: null, error: 'page too short' };
  }
  let aiJson;
  try {
    ({ aiJson } = await import('@/lib/ai-structured'));
  } catch {
    return { platform: 'ai-fallback', confidence: 'low', product: null, error: 'ai module unavailable' };
  }
  type AiOut = {
    is_product?: boolean;
    title?: string | null;
    brand?: string | null;
    description?: string | null;
    price?: number | string | null;
    currency?: string | null;
    image?: string | null;
    confidence?: string | null;
  };
  try {
    const out = await aiJson<AiOut>({
      systemPrompt:
        'You analyse the text content of a web page and decide if it is a SINGLE PRODUCT detail page for refurbished or new lab/analytical equipment. If yes, extract the product fields. If the page looks like a homepage, category listing, blog post, news article, or unrelated content, respond with {"is_product": false}. Never invent data — only return fields visible in the text.',
      userPrompt:
        `URL: ${finalUrl}\n\nPAGE TEXT (truncated):\n${cleaned}\n\nReturn JSON exactly: {"is_product": <bool>, "title": <str|null>, "brand": <str|null>, "description": <str|null>, "price": <number|null>, "currency": <str|null>, "image": <str|null>, "confidence": "low" | "medium"}.`,
      maxTokens: 800,
      temperature: 0.1,
    });
    if (!out.is_product || !out.title) {
      return { platform: 'ai-fallback', confidence: 'low', product: null, error: out.is_product === false ? 'AI: not a product page' : 'AI returned no title' };
    }
    return {
      platform: 'ai-fallback',
      confidence: 'low',
      product: {
        title: clean(out.title, 200) ?? out.title.slice(0, 200),
        summary: null,
        description: clean(out.description ?? null),
        brand: clean(out.brand ?? null, 80),
        condition: null,
        priceCents: out.price != null ? priceCentsFrom(out.price) : null,
        currency: clean(out.currency ?? null, 3) || CURRENCY_FALLBACK,
        images: out.image ? [out.image] : [],
        specs: {},
        warnings: ['Extracted by AI fallback — verify every field before publishing.'],
      },
    };
  } catch (e) {
    return { platform: 'ai-fallback', confidence: 'low', product: null, error: e instanceof Error ? e.message.slice(0, 200) : 'ai-fallback failed' };
  }
}
