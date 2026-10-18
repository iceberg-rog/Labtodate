import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '@/lib/storage/s3';
import { safeFetch } from '@/lib/import/safe-fetch';

/**
 * The company logo as a data: URI, so documents are fully self-contained: the
 * PDF renderer blocks every network request (no SSRF, no slow third-party
 * host stalling a render) and an emailed/downloaded HTML preview still shows
 * the logo. Raster only (the admin upload accepts png/jpeg/webp).
 *
 * A loaded logo is cached for a few minutes; a failure only for
 * FAILURE_TTL_MS (previews), so a storage hiccup is retried soon. A logo that
 * is configured but could not be loaded is an error for the stored PDF
 * (`strict`, ensureDocumentPdf — which always tries the logo again): the render
 * fails and the next download retries — an issued document is never stored
 * unbranded because of a hiccup. Previews (not stored) fall back to the name.
 *
 * An absolute https URL set by an admin is fetched through safeFetch (public
 * addresses only, every redirect re-checked), as Settings → Verify does.
 */
const TTL_MS = 10 * 60_000;
export const FAILURE_TTL_MS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;

type CacheEntry = { at: number; value: string } | { at: number; error: string };
const cache = new Map<string, CacheEntry>();

/** A configured logo could not be loaded (the stored PDF must not be rendered without it). */
export class LogoUnavailableError extends Error {}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

function toDataUri(buf: Buffer, mime: string): string {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new Error(`not a png / jpeg / webp / gif image (${mime || 'unknown type'})`);
  if (buf.length === 0) throw new Error('empty file');
  if (buf.length > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES / 1024 / 1024} MB`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function mimeFromName(name: string): string {
  const ext = name.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? '';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Object key when the URL points into our own bucket (public URL or /media proxy). */
function bucketKeyFor(url: string): string | null {
  const publicUrl = (process.env.S3_PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl && url.startsWith(`${publicUrl}/`)) return decodeURIComponent(url.slice(publicUrl.length + 1));
  const media = new RegExp(`^(?:https?://[^/]+)?/media/${BUCKET_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)$`);
  const m = media.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/** The logo as a data: URI; throws with the reason when it can not be loaded. */
async function load(url: string): Promise<string> {
  // 1) Our own bucket — read it through the internal S3 endpoint (works inside
  //    Docker where the public hostname may not resolve).
  const key = bucketKeyFor(url);
  if (key) {
    const out = await withTimeout(s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })), 4000);
    const bytes = out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
    return toDataUri(bytes, out.ContentType || mimeFromName(key));
  }
  // 2) A site-relative file shipped in /public.
  if (url.startsWith('/') && !url.startsWith('//')) {
    const rel = path.normalize(url.split('?')[0]).replace(/^([/\\])+/, '');
    if (rel.includes('..')) throw new Error('path outside /public');
    const buf = await readFile(path.join(process.cwd(), 'public', rel));
    return toDataUri(buf, mimeFromName(rel));
  }
  // 3) An absolute https URL set by an admin — public hosts only (SSRF guard).
  if (/^https:\/\//i.test(url)) {
    const res = await safeFetch(url, { timeoutMs: 4000, maxBytes: MAX_BYTES, accept: 'image/*' });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const mime = (res.contentType || '').split(';')[0].trim() || mimeFromName(url);
    return toDataUri(res.raw, mime);
  }
  throw new Error('not an https URL, a /media upload or a site path');
}

/** Whether a cache entry still answers at `now` (a success for TTL_MS, a failure only for FAILURE_TTL_MS). */
export function logoCacheFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return now - entry.at < ('value' in entry ? TTL_MS : FAILURE_TTL_MS);
}

/**
 * The logo at `logoUrl` as a data: URI; null when no logo is configured.
 * A configured logo that can not be loaded: null (the name is printed) — or,
 * with `strict`, a LogoUnavailableError.
 */
export async function companyLogoDataUri(logoUrl: string | null | undefined, opts: { strict?: boolean } = {}): Promise<string | null> {
  const url = (logoUrl || '').trim();
  if (!url) return null;
  let entry = cache.get(url);
  // The stored PDF (strict) never relies on a cached failure: it tries again.
  if (!logoCacheFresh(entry, Date.now()) || (opts.strict && entry && 'error' in entry)) {
    try {
      entry = { at: Date.now(), value: await load(url) };
    } catch (e) {
      entry = { at: Date.now(), error: e instanceof Error ? e.message : String(e) };
      console.error(`[documents] logo ${url} could not be loaded:`, entry.error);
    }
    cache.set(url, entry);
  }
  if (entry && 'value' in entry) return entry.value;
  if (opts.strict) throw new LogoUnavailableError(`The company logo (${url}) could not be loaded (${entry?.error ?? 'unknown error'}).`);
  return null;
}
