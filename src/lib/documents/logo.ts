import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '@/lib/storage/s3';

/**
 * The company logo as a data: URI, so documents are fully self-contained: the
 * PDF renderer blocks every network request (no SSRF, no slow third-party
 * host stalling a render) and an emailed/downloaded HTML preview still shows
 * the logo. Raster only (the admin upload accepts png/jpeg/webp). Cached for a
 * few minutes; any failure → null and the document falls back to the name.
 */
const TTL_MS = 10 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, { at: number; value: string | null }>();

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

function toDataUri(buf: Buffer, mime: string): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return null;
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
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

async function load(url: string): Promise<string | null> {
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
    if (rel.includes('..')) return null;
    const buf = await readFile(path.join(process.cwd(), 'public', rel));
    return toDataUri(buf, mimeFromName(rel));
  }
  // 3) An absolute https URL set by an admin.
  if (/^https:\/\//i.test(url)) {
    const res = await withTimeout(fetch(url, { redirect: 'follow' }), 4000);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || mimeFromName(url);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return null;
    return toDataUri(Buffer.from(await res.arrayBuffer()), mime);
  }
  return null;
}

export async function companyLogoDataUri(logoUrl: string | null | undefined): Promise<string | null> {
  const url = (logoUrl || '').trim();
  if (!url) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    value = await load(url);
  } catch (e) {
    console.error('[documents] logo could not be loaded, using the company name instead:', e instanceof Error ? e.message : e);
  }
  cache.set(url, { at: Date.now(), value });
  return value;
}
