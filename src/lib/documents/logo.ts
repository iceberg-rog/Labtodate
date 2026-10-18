import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '@/lib/storage/s3';
import { safeFetch, SafeFetchError } from '@/lib/import/safe-fetch';

/**
 * The company logo as a data: URI, so documents are fully self-contained: the
 * PDF renderer blocks every network request (no SSRF, no slow third-party
 * host stalling a render) and an emailed/downloaded HTML preview still shows
 * the logo. Raster only (png / jpeg / webp / gif up to 2 MB; the admin upload
 * accepts png/jpeg/webp).
 *
 * A loaded logo is cached for a few minutes; a failure only for
 * FAILURE_TTL_MS (previews), so a storage hiccup is retried soon. For the
 * stored PDF (documentLogo, ensureDocumentPdf — which always tries the logo
 * again) a failure is one of two kinds:
 *  - transient (timeout, network, storage 5xx / throttling): the render fails
 *    and the next download retries — an issued document is never stored
 *    unbranded because of a hiccup;
 *  - permanent (file missing, wrong type, too large, address not allowed):
 *    retrying can not help — an admin must fix Settings → Company → Logo; the
 *    caller alerts them and the document is rendered with the company name.
 * Previews (not stored) fall back to the name.
 *
 * An absolute https URL set by an admin is fetched through safeFetch (public
 * addresses only, every redirect re-checked), as Settings → Verify does —
 * which checks the logo with this same loader (checkDocumentLogo), so the two
 * agree on what documents can use.
 */
const TTL_MS = 10 * 60_000;
export const FAILURE_TTL_MS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;

type CacheEntry = { at: number; value: string } | { at: number; error: string; permanent: boolean };
const cache = new Map<string, CacheEntry>();

/**
 * A configured logo can not be used. `permanent`: retrying will not help
 * (see logoFailureIsPermanent) — otherwise the next attempt may succeed.
 */
export class LogoUnavailableError extends Error {
  constructor(message: string, readonly reason: string, readonly permanent: boolean) {
    super(message);
  }
}

/** A logo problem no retry can fix (wrong type, empty, too large, unsupported address, HTTP 4xx). */
class LogoFileError extends Error {}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

function toDataUri(buf: Buffer, mime: string): string {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new LogoFileError(`not a png / jpeg / webp / gif image (${mime || 'unknown type'})`);
  if (buf.length === 0) throw new LogoFileError('empty file');
  if (buf.length > MAX_BYTES) throw new LogoFileError(`larger than ${MAX_BYTES / 1024 / 1024} MB`);
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
    if (rel.includes('..')) throw new LogoFileError('path outside /public');
    const buf = await readFile(path.join(process.cwd(), 'public', rel));
    return toDataUri(buf, mimeFromName(rel));
  }
  // 3) An absolute https URL set by an admin — public hosts only (SSRF guard).
  if (/^https:\/\//i.test(url)) {
    const res = await safeFetch(url, { timeoutMs: 4000, maxBytes: MAX_BYTES, accept: 'image/*' });
    if (res.status < 200 || res.status >= 300) {
      // 404 / 403 / 410 …: the address is wrong; 5xx, 408 and 429: the host may answer later.
      const permanent = res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw permanent ? new LogoFileError(`HTTP ${res.status}`) : new Error(`HTTP ${res.status}`);
    }
    const mime = (res.contentType || '').split(';')[0].trim() || mimeFromName(url);
    return toDataUri(res.raw, mime);
  }
  throw new LogoFileError('not an https URL, a /media upload or a site path');
}

/**
 * Can retrying help? No for: the loader's own refusals (type, size, empty,
 * address), a missing or unreadable file (ENOENT …), an object that is not in
 * the bucket or not allowed (NoSuchKey, 403 / 404), and addresses safeFetch
 * refuses (private IP, bad scheme / host, redirect loop, too large). Yes for
 * everything else: timeouts, network and DNS errors, storage 5xx / throttling.
 */
export function logoFailureIsPermanent(e: unknown): boolean {
  if (e instanceof LogoFileError) return true;
  if (e instanceof SafeFetchError) return ['BAD_SCHEME', 'BAD_HOST', 'PRIVATE_IP', 'TOO_MANY_REDIRECTS', 'TOO_LARGE'].includes(e.code);
  const err = (e && typeof e === 'object' ? e : {}) as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof err.code === 'string' && ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(err.code)) return true;
  if (typeof err.name === 'string' && ['NoSuchKey', 'NotFound', 'NoSuchBucket', 'AccessDenied', 'InvalidObjectState'].includes(err.name)) return true;
  const status = err.$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Whether a cache entry still answers at `now` (a success for TTL_MS, a failure only for FAILURE_TTL_MS). */
export function logoCacheFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return now - entry.at < ('value' in entry ? TTL_MS : FAILURE_TTL_MS);
}

export interface DocumentLogo {
  /** The logo as a data: URI; null when none is configured or it can not be used. */
  dataUri: string | null;
  /** Why a configured logo can not be used (`permanent`: retrying will not help). */
  problem: { reason: string; permanent: boolean } | null;
}

/**
 * The logo at `logoUrl` with the reason when it can not be used. `fresh` (the
 * stored PDF): a cached failure is not trusted — it is tried again.
 */
export async function documentLogo(logoUrl: string | null | undefined, opts: { fresh?: boolean } = {}): Promise<DocumentLogo> {
  const url = (logoUrl || '').trim();
  if (!url) return { dataUri: null, problem: null };
  let entry = cache.get(url);
  if (!logoCacheFresh(entry, Date.now()) || (opts.fresh && entry && 'error' in entry)) {
    try {
      entry = { at: Date.now(), value: await load(url) };
    } catch (e) {
      entry = { at: Date.now(), error: e instanceof Error ? e.message : String(e), permanent: logoFailureIsPermanent(e) };
      console.error(`[documents] logo ${url} could not be loaded (${entry.permanent ? 'permanent' : 'retryable'}):`, entry.error);
    }
    cache.set(url, entry);
  }
  if (entry && 'value' in entry) return { dataUri: entry.value, problem: null };
  return { dataUri: null, problem: { reason: entry?.error ?? 'unknown error', permanent: entry?.permanent ?? false } };
}

/**
 * The logo at `logoUrl` as a data: URI; null when no logo is configured.
 * A configured logo that can not be used: null (the name is printed) — or,
 * with `strict` (fresh attempt), a LogoUnavailableError saying whether
 * retrying can help.
 */
export async function companyLogoDataUri(logoUrl: string | null | undefined, opts: { strict?: boolean } = {}): Promise<string | null> {
  const r = await documentLogo(logoUrl, { fresh: opts.strict });
  if (!r.problem || !opts.strict) return r.dataUri;
  throw new LogoUnavailableError(`The company logo (${(logoUrl || '').trim()}) could not be loaded (${r.problem.reason}).`, r.problem.reason, r.problem.permanent);
}

/**
 * Settings → Verify for the document logo: the very loader the PDF uses (fresh,
 * not cached), so Verify accepts exactly what documents can print.
 */
export async function checkDocumentLogo(logoUrl: string): Promise<{ ok: boolean; message: string }> {
  const r = await documentLogo(logoUrl, { fresh: true });
  if (r.dataUri) {
    const mime = /^data:([^;]+);/.exec(r.dataUri)?.[1] ?? 'image';
    return { ok: true, message: `Usable on documents (${mime}, ${Math.round((r.dataUri.length * 3) / 4 / 1024)} KB).` };
  }
  if (!r.problem) return { ok: false, message: 'Empty — save a value first, then verify.' };
  return r.problem.permanent
    ? { ok: false, message: `Documents can not use this logo: ${r.problem.reason}. Upload a png / jpeg / webp of at most ${MAX_BYTES / 1024 / 1024} MB (or enter an https address of one).` }
    : { ok: false, message: `Could not be loaded right now (${r.problem.reason}) — try Verify again in a minute.` };
}
