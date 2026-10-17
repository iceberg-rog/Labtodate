/**
 * Re-host a supplier's product photo in lab2date's own media store.
 *
 * Key = sha1(source URL) (same scheme as the original prisma/localize-images.ts,
 * so photos localised by that script are recognised and never fetched twice).
 * The stored value is the host-relative "/media/<bucket>/<key>" path.
 *
 * Safety: only http(s); the host must resolve to a public address (a supplier
 * API is third-party data and could point at internal services); redirects
 * are followed manually and re-checked; the body must really be a JPEG / PNG /
 * WEBP / GIF (magic bytes) and at most IMPORT_PHOTO_MAX_MB (Settings → Import &
 * suppliers, default 20 MB).
 * IMPORT_PRIVATE_HOST_ALLOWLIST (comma-separated host names, e.g. "127.0.0.1")
 * exempts specific hosts — ONLY for local tests against a mock shop; never in
 * production.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3, uploadObject, BUCKET_NAME } from '@/lib/storage/s3';
import { sniffUploadKind } from '@/lib/storage/file-type';
import { ownMediaPath } from '@/lib/media/public-src';
import { classifyIp } from '@/lib/import/safe-fetch';

/** Largest photo copied from a source (Settings → Import & suppliers; hydrated into process.env). */
function maxPhotoMb(): number {
  const n = parseInt(process.env.IMPORT_PHOTO_MAX_MB ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 20;
}
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** Same key derivation as prisma/localize-images.ts (kept for idempotency). */
export function importImageKey(sourceUrl: string): string {
  const hash = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 20);
  const ext =
    (sourceUrl.split('?')[0].split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  return `products/import/${hash}.${ext}`;
}

/** The "/media/…" path a source URL is (or will be) stored at. */
export function importImagePath(sourceUrl: string): string {
  return `/media/${BUCKET_NAME}/${importImageKey(sourceUrl)}`;
}

/** Private / loopback / link-local / reserved address? (shared rule: src/lib/import/safe-fetch.ts) */
export function isPrivateAddress(ip: string): boolean {
  return classifyIp(ip) !== null;
}

/** Throws unless the URL's host resolves only to public addresses (SSRF guard). */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allow = (process.env.IMPORT_PRIVATE_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allow.includes(host.toLowerCase())) return;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`refusing to fetch from a private address (${host})`);
  }
}

/**
 * fetch() for third-party sources (supplier APIs): every hop — the first URL
 * and each redirect target — must resolve to a public address (SSRF guard).
 */
export async function fetchPublic(url: string, init: RequestInit = {}, maxRedirects = MAX_REDIRECTS): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('not an http(s) URL');
    await assertPublicHost(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} without Location`);
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

async function fetchImageBytes(src: string): Promise<{ buf: Buffer; mime: string }> {
  let current = new URL(src);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('not an http(s) URL');
    await assertPublicHost(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'lab2date-media-import/1.0', Accept: 'image/*' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} without Location`);
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mb = maxPhotoMb();
    const limit = mb * 1024 * 1024;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > limit) throw new Error(`image larger than ${mb} MB`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`image larger than ${mb} MB`);
    if (buf.length < 100) throw new Error('empty or truncated image');
    const kind = sniffUploadKind(buf);
    if (!kind || !MIME[kind]) throw new Error('not a JPEG, PNG, WEBP or GIF image');
    return { buf, mime: MIME[kind] };
  }
  throw new Error('too many redirects');
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export type LocalizeResult =
  | { ok: true; path: string; reused: boolean }
  | { ok: false; error: string };

/** Store one remote image in our media store (or find it already there). */
export async function localizeImage(sourceUrl: string): Promise<LocalizeResult> {
  const own = ownMediaPath(sourceUrl);
  if (own) return { ok: true, path: own, reused: true };
  const key = importImageKey(sourceUrl);
  const path = importImagePath(sourceUrl);
  try {
    if (await objectExists(key)) return { ok: true, path, reused: true };
    const { buf, mime } = await fetchImageBytes(sourceUrl);
    await uploadObject(key, buf, mime);
    return { ok: true, path, reused: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'download failed' };
  }
}

export interface LocalizedList {
  /** New `images` value: own paths in source order; a remote URL that failed stays (hidden from buyers, retried next run). */
  images: string[];
  /** Remote URLs seen (provenance for Product.sourceImageUrls). */
  remote: string[];
  failures: { url: string; error: string }[];
  downloaded: number;
  changed: boolean;
}

/** Localise every image in a product's list, with a small concurrency limit. */
export async function localizeImageList(images: readonly string[], concurrency = 4): Promise<LocalizedList> {
  const out: string[] = new Array(images.length);
  const remote: string[] = [];
  const failures: { url: string; error: string }[] = [];
  let downloaded = 0;
  let i = 0;
  async function worker() {
    while (i < images.length) {
      const idx = i++;
      const src = images[idx];
      const own = ownMediaPath(src);
      if (own) {
        out[idx] = own;
        continue;
      }
      remote.push(src);
      const r = await localizeImage(src);
      if (r.ok) {
        out[idx] = r.path;
        if (!r.reused) downloaded++;
      } else {
        out[idx] = src;
        failures.push({ url: src, error: r.error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, images.length)) }, worker));
  const dedup: string[] = [];
  for (const u of out) if (u && !dedup.includes(u)) dedup.push(u);
  const changed = dedup.length !== images.length || dedup.some((u, k) => u !== images[k]);
  return { images: dedup, remote, failures, downloaded, changed };
}
