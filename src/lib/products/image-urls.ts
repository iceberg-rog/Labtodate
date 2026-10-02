/**
 * Which photo URLs a product listing may store.
 *
 * Seller photos are uploaded through /api/upload → uploadObject()
 * (src/lib/storage/s3.ts), which answers `${S3_PUBLIC_URL}/products/<key>`;
 * in production that is the site's own /media/<bucket>/… proxy. The seller
 * form must only save URLs of that shape. Anything else — javascript:, data:,
 * or a pixel on someone else's host — would be rendered with a plain
 * <img src> on the admin review screens and fetched by the reviewer's browser.
 */

/** Path the site serves the upload store under (next.config rewrite / nginx). */
const MEDIA_PATH = '/media/';
const RELATIVE_BASE = 'http://relative.invalid';

/** Mirrors PUBLIC_URL in src/lib/storage/s3.ts. */
function uploadBaseUrl(): string {
  const endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000';
  const bucket = process.env.S3_BUCKET || 'lab2date-media';
  return (process.env.S3_PUBLIC_URL || `${endpoint}/${bucket}`).replace(/\/+$/, '');
}

function siteOrigin(): string | null {
  for (const v of [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_BETTER_AUTH_URL]) {
    if (!v) continue;
    try {
      return new URL(v).origin;
    } catch {
      // ignore a malformed env value
    }
  }
  return null;
}

/**
 * An absolute http(s) URL or a host-relative path ("/media/…"). Every other
 * scheme (javascript:, data:, blob:, file:…), protocol-relative "//host"
 * URLs, embedded credentials and control characters are refused.
 */
function parseImageUrl(raw: string): { url: URL; relative: boolean } | null {
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  const relative = raw.startsWith('/') && !raw.startsWith('//');
  let url: URL;
  try {
    url = relative ? new URL(raw, RELATIVE_BASE) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (relative && url.origin !== RELATIVE_BASE) return null;
  return { url, relative };
}

/** A plain web image address (http, https or a site path) — never javascript:/data:. */
export function isSafeImageUrl(raw: string): boolean {
  return parseImageUrl(raw) !== null;
}

/** True only for files in our own upload store: under S3_PUBLIC_URL, or the
 *  site's /media/ path (host-relative or on the site's own origin). */
export function isOwnMediaUrl(raw: string): boolean {
  const parsed = parseImageUrl(raw);
  if (!parsed) return false;
  const { url, relative } = parsed;
  // URL() has already resolved "." / ".." segments (also %2e-encoded ones),
  // so a prefix check on the pathname can't be walked out of.
  const path = url.pathname;

  const base = parseImageUrl(uploadBaseUrl());
  if (base) {
    const basePath = base.url.pathname.replace(/\/+$/, '') + '/';
    const sameHost = base.relative ? relative : !relative && url.origin === base.url.origin;
    if (sameHost && path.startsWith(basePath)) return true;
  }

  if (path.startsWith(MEDIA_PATH)) {
    if (relative) return true;
    const origin = siteOrigin();
    if (origin && url.origin === origin) return true;
  }
  return false;
}
