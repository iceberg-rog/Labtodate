/**
 * Localize all product images off the source shops (lab2parts.com /
 * lab2.nl) into our own MinIO/R2 storage. After this, lab2date has
 * ZERO live dependency on those sites.
 *
 * Idempotent — stable keys (hash of source URL), skips already-local.
 *
 *   npx tsx prisma/localize-images.ts
 */

import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { uploadObject, ensureBucket } from '../src/lib/storage/s3';

const prisma = new PrismaClient();

const REMOTE_HOSTS = ['lab2parts.com', 'lab2.nl'];
const PUBLIC_PREFIX = process.env.S3_PUBLIC_URL || 'http://localhost:9000/lab2date-media';
const CONCURRENCY = 6;

function isRemote(url: string): boolean {
  return REMOTE_HOSTS.some((h) => url.includes(h));
}

function keyFor(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 20);
  const ext = (url.split('?')[0].split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  return `products/import/${hash}.${ext}`;
}

async function localizeOne(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const key = keyFor(url);
    const { url: publicUrl } = await uploadObject(key, buf, ct);
    return publicUrl;
  } catch {
    return null;
  }
}

async function main() {
  await ensureBucket();
  console.log('⇣ Localizing product images into own storage…');

  const products = await prisma.product.findMany({
    where: { images: { isEmpty: false } },
    select: { id: true, images: true },
  });
  console.log(`  ${products.length} products with images`);

  // Build the unique remote-URL set → resolved local URL (so duplicate
  // images across products are fetched/uploaded once).
  const remoteUrls = new Set<string>();
  for (const p of products) for (const u of p.images) if (isRemote(u)) remoteUrls.add(u);
  const all = [...remoteUrls];
  console.log(`  ${all.length} unique remote images to migrate`);

  const resolved = new Map<string, string | null>();
  let done = 0;
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((u) => localizeOne(u).then((r) => [u, r] as const)));
    for (const [u, r] of results) resolved.set(u, r);
    done += batch.length;
    if (done % 60 === 0 || done >= all.length) console.log(`  ${done}/${all.length} migrated`);
  }

  // Rewrite each product's images array.
  let updated = 0;
  let dropped = 0;
  for (const p of products) {
    let changed = false;
    const next: string[] = [];
    for (const u of p.images) {
      if (!isRemote(u)) { next.push(u); continue; }
      const local = resolved.get(u);
      if (local) { next.push(local); changed = true; }
      else { changed = true; dropped++; } // failed → drop, card falls back to placeholder
    }
    if (changed) {
      await prisma.product.update({
        where: { id: p.id },
        data: { images: next, hasImages: next.length > 0 },
      });
      updated++;
    }
  }

  const stillRemote = await prisma.product.count({
    where: { OR: REMOTE_HOSTS.map((h) => ({ images: { has: h } })) },
  });

  console.log('\n✅ Done.', {
    productsUpdated: updated,
    imagesMigrated: [...resolved.values()].filter(Boolean).length,
    imagesFailedDropped: dropped,
    publicPrefix: PUBLIC_PREFIX,
  });
  console.log(`   Sanity: products still containing a source-shop string ≈ ${stillRemote} (substring match, expect 0)`);
}

main()
  .catch((e) => { console.error('Localize failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
