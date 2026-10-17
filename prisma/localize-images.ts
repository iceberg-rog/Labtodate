/**
 * Copy every product photo that is still on a foreign server (supplier site,
 * CDN) into lab2date's own media store, and tidy own-store URLs to the
 * host-relative "/media/<bucket>/<key>" form. DRY RUN by default.
 *
 *   npx tsx prisma/localize-images.ts            # report only
 *   npx tsx prisma/localize-images.ts --apply    # copy + rewrite Product.images
 *
 * Same code as Admin → Products → "Self-host photos" and the supplier sync
 * (src/lib/media/localize.ts): key = sha1(source URL), so photos copied by the
 * earlier version of this script are recognised and not downloaded again.
 * A photo that cannot be copied stays in the list (hidden from buyers by
 * src/lib/media/public-src.ts) and is retried on the next run; the supplier's
 * original URL is kept in Product.sourceImageUrls.
 */
import { prisma } from '../src/lib/db';
import { localizeImageList } from '../src/lib/media/localize';
import { isOwnStoredImage, ownMediaPath, publicProductImages } from '../src/lib/media/public-src';

async function main() {
  const apply = process.argv.includes('--apply');
  const all = await prisma.product.findMany({
    select: { id: true, slug: true, images: true, sourceImageUrls: true },
    orderBy: { id: 'asc' },
  });
  const todo = all.filter((p) => p.images.some((u) => ownMediaPath(u) !== u));
  const foreign = todo.reduce((n, p) => n + p.images.filter((u) => !isOwnStoredImage(u)).length, 0);
  console.log(`${all.length} products · ${todo.length} need work · ${foreign} photo(s) on foreign servers`);
  if (!apply) {
    const hosts = new Map<string, number>();
    for (const p of todo) for (const u of p.images) if (!isOwnStoredImage(u)) {
      let h = 'invalid';
      try { h = new URL(u).host; } catch { /* keep */ }
      hosts.set(h, (hosts.get(h) ?? 0) + 1);
    }
    for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${h}: ${n}`);
    console.log('Dry run — add --apply to copy them.');
    return;
  }
  let downloaded = 0;
  let hosted = 0;
  let failed = 0;
  let done = 0;
  for (const p of todo) {
    const remote = p.images.filter((u) => !isOwnStoredImage(u));
    const loc = await localizeImageList(p.images);
    downloaded += loc.downloaded;
    hosted += remote.length - loc.failures.length;
    failed += loc.failures.length;
    for (const f of loc.failures) console.warn(`  ! ${p.slug}: ${f.url} — ${f.error}`);
    if (loc.changed) {
      await prisma.product.update({
        where: { id: p.id },
        data: {
          images: loc.images,
          hasImages: publicProductImages(loc.images).length > 0,
          sourceImageUrls: Array.from(new Set([...p.sourceImageUrls, ...remote])),
        },
      });
    }
    done++;
    if (done % 50 === 0 || done === todo.length) console.log(`  ${done}/${todo.length} products`);
  }
  const left = (await prisma.product.findMany({ select: { images: true } })).filter((p) => p.images.some((u) => !isOwnStoredImage(u))).length;
  console.log(`\nDone: ${hosted} photo(s) now served from our store (${downloaded} downloaded, the rest already stored), ${failed} failed (retried next run), ${left} product(s) still have a foreign photo.`);
  await prisma.auditLog.create({
    data: { actorEmail: 'system:cli', action: 'catalog.images.localize', meta: `hosted=${hosted} downloaded=${downloaded} failed=${failed} left=${left}` },
  });
}

main()
  .catch((e) => {
    console.error('Localize failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
