/**
 * Product photos shown to buyers come ONLY from lab2date's own media store.
 *
 * Stored URLs take three shapes:
 *   - "/media/<bucket>/<key>"                      (host-relative; what new imports store)
 *   - "${S3_PUBLIC_URL}/<key>"                      (absolute; uploads, legacy localised images)
 *   - "https://<site>/media/<bucket>/<key>"         (absolute on our own domain)
 * All three are served by the same /media/ proxy (nginx in production, the
 * next.config rewrite for the image optimizer), so they are normalised to the
 * host-relative path. next/image then treats them as local images and never
 * needs a remote host allow-list.
 *
 * Anything else — a supplier's own URL (lab2parts.com/…), a CDN, http:// — is
 * NOT ours: it is dropped from buyer-facing output instead of being hotlinked,
 * which would leak the hidden supplier and break when the source changes.
 * Server-only (reads runtime env).
 */

const MEDIA_PREFIX = '/media/';

function bucket(): string {
  return process.env.S3_BUCKET || 'lab2date-media';
}

function publicBase(): string {
  const endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000';
  return (process.env.S3_PUBLIC_URL || `${endpoint}/${bucket()}`).replace(/\/+$/, '');
}

function siteOrigins(): string[] {
  const out: string[] = [];
  for (const v of [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_BETTER_AUTH_URL]) {
    if (!v) continue;
    try {
      out.push(new URL(v).origin);
    } catch {
      /* ignore malformed env */
    }
  }
  return out;
}

/** Collapse "." / ".." and refuse anything that leaves /media/. */
function safeMediaPath(pathname: string, search = ''): string | null {
  let u: URL;
  try {
    u = new URL(pathname, 'http://x.invalid');
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(MEDIA_PREFIX) || u.pathname.length <= MEDIA_PREFIX.length) return null;
  return u.pathname + (search || '');
}

/**
 * The host-relative "/media/…" path for an image in our own store, or null when
 * the URL is not ours (or not a valid http(s)/path URL at all).
 */
export function ownMediaPath(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(s)) return null;
  if (s.startsWith('/') && !s.startsWith('//')) {
    const q = s.indexOf('?');
    return safeMediaPath(q === -1 ? s : s.slice(0, q), q === -1 ? '' : s.slice(q));
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  // The current public base, plus earlier ones the store was published under
  // (MEDIA_LEGACY_PUBLIC_URLS, comma-separated — e.g. the server IP used before
  // the domain): same bucket, same keys, so they are ours too.
  const bases = [
    publicBase(),
    ...(process.env.MEDIA_LEGACY_PUBLIC_URLS ?? '').split(',').map((b) => b.trim().replace(/\/+$/, '')).filter(Boolean),
  ];
  for (const base of bases) {
    if (!s.startsWith(`${base}/`)) continue;
    const key = s.slice(base.length + 1).split('?')[0];
    if (!key || key.split('/').some((seg) => seg === '..' || seg === '.')) return null;
    return safeMediaPath(`${MEDIA_PREFIX}${bucket()}/${key}`);
  }
  if (siteOrigins().includes(url.origin) && url.pathname.startsWith(MEDIA_PREFIX)) {
    return safeMediaPath(url.pathname, url.search);
  }
  return null;
}

/** True when the URL points into our own media store (any of the three shapes). */
export function isOwnStoredImage(raw: string | null | undefined): boolean {
  return ownMediaPath(raw) !== null;
}

/** Buyer-facing photo list: own-store images as "/media/…" paths, in order; foreign URLs dropped. */
export function publicProductImages(images: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const u of images ?? []) {
    const p = ownMediaPath(u);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** First buyer-facing photo, or null. */
export function firstPublicImage(images: readonly string[] | null | undefined): string | null {
  for (const u of images ?? []) {
    const p = ownMediaPath(u);
    if (p) return p;
  }
  return null;
}

/** Absolute URL on the site's own origin (OG tags, JSON-LD, emails). */
export function absoluteSiteUrl(path: string): string {
  const origin = siteOrigins()[0] ?? 'https://labtodate.com';
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}
