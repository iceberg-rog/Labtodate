/**
 * Product photos are stored host-relative ("/media/<bucket>/<key>"), so a new
 * domain, IP or S3_PUBLIC_URL never hides them. Older rows can still hold an
 * absolute URL of our own store under a host the current settings do not know
 * (e.g. https://87.107.206.76/media/lab2date-media/… from before the domain):
 * public-src.ts drops such URLs (fail-closed), so buyers would see "Photo on
 * request" without anyone noticing.
 *
 * normalizeProductMediaUrls() rewrites every URL that is ours to the
 * host-relative form — recognised by the configured bases (public-src.ts) or,
 * for an unknown host, by a /media/<bucket>/<key> path whose object really
 * exists in our bucket (HEAD). Anything else (a supplier's server) is left for
 * the photo re-hosting. Idempotent; runs in the deploy `setup` step
 * (npm run media:normalize -- --apply) and is checked at server start
 * (src/instrumentation.ts → mediaUrlProblems()).
 */
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import { s3, BUCKET_NAME } from '@/lib/storage/s3';
import { ownMediaPath } from '@/lib/media/public-src';

/** "/media/<bucket>/<key>" of an absolute URL on ANY host, or null. */
export function mediaPathOnAnyHost(raw: string): { path: string; key: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const prefix = `/media/${BUCKET_NAME}/`;
  if (!u.pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(u.pathname.slice(prefix.length));
  if (!key || key.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return { path: `${prefix}${key}`, key };
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export interface NormalizeResult {
  products: number;
  rewritten: number;
  /** Absolute /media/<bucket>/ URLs on an unknown host whose object is NOT in our bucket. */
  missing: string[];
  /** URLs on other servers (supplier photos) — for the re-hosting tool, not this one. */
  foreign: number;
}

export async function normalizeProductMediaUrls(db: PrismaClient, opts: { apply: boolean }): Promise<NormalizeResult> {
  const rows = await db.product.findMany({ select: { id: true, images: true } });
  const out: NormalizeResult = { products: 0, rewritten: 0, missing: [], foreign: 0 };
  const exists = new Map<string, boolean>();
  for (const p of rows) {
    let changed = false;
    const next: string[] = [];
    for (const u of p.images) {
      const own = ownMediaPath(u);
      if (own) {
        if (own !== u) changed = true;
        next.push(own);
        continue;
      }
      const m = mediaPathOnAnyHost(u);
      if (m) {
        if (!exists.has(m.key)) exists.set(m.key, await objectExists(m.key));
        if (exists.get(m.key)) {
          next.push(m.path);
          changed = true;
          continue;
        }
        out.missing.push(u);
      } else if (/^https?:\/\//i.test(u)) {
        out.foreign++;
      }
      next.push(u);
    }
    if (!changed) continue;
    const dedup = next.filter((u, i) => next.indexOf(u) === i);
    out.products++;
    out.rewritten += p.images.filter((u, i) => u !== next[i]).length;
    if (opts.apply) await db.product.update({ where: { id: p.id }, data: { images: dedup, hasImages: dedup.some((u) => !!ownMediaPath(u)) } });
  }
  return out;
}

/**
 * Startup check: photos stored as an absolute URL of a /media/ store under a
 * host this server does not recognise — buyers do not see them. Cheap (no S3).
 */
export async function mediaUrlProblems(db: PrismaClient): Promise<{ products: number; photos: number; hosts: string[] }> {
  const rows = await db.product.findMany({ where: { status: 'PUBLISHED' }, select: { images: true } });
  const hosts = new Set<string>();
  let products = 0;
  let photos = 0;
  for (const r of rows) {
    const bad = r.images.filter((u) => !ownMediaPath(u) && mediaPathOnAnyHost(u));
    if (!bad.length) continue;
    products++;
    photos += bad.length;
    for (const u of bad) {
      try {
        hosts.add(new URL(u).host);
      } catch {
        /* not a URL */
      }
    }
  }
  return { products, photos, hosts: [...hosts].slice(0, 5) };
}
