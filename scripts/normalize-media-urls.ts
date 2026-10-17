/**
 * Rewrite product photo URLs of OUR media store to the host-relative
 * "/media/<bucket>/<key>" form (src/lib/media/normalize.ts), so photos never
 * depend on the host they were saved under (old server IP, old domain,
 * S3_PUBLIC_URL) and no MEDIA_LEGACY_PUBLIC_URLS line is needed after a move.
 * A URL on an unknown host counts as ours only when its object exists in our
 * bucket. Idempotent. Runs in the deploy `setup` step.
 *
 *   node --env-file=.env --import tsx scripts/normalize-media-urls.ts          # dry run
 *   node --env-file=.env --import tsx scripts/normalize-media-urls.ts --apply
 */
import { prisma } from '../src/lib/db';
import { normalizeProductMediaUrls } from '../src/lib/media/normalize';

async function main() {
  const apply = process.argv.includes('--apply');
  const r = await normalizeProductMediaUrls(prisma, { apply });
  console.log(
    `${apply ? 'Applied' : 'Dry run'}: ${r.products} product(s), ${r.rewritten} photo URL(s) ${apply ? 'rewritten' : 'would be rewritten'} to /media/… paths.` +
      ` ${r.foreign} photo(s) are on other servers (supplier photos — Admin → Products → copy them to our store).`,
  );
  if (r.missing.length) {
    console.error(`WARNING: ${r.missing.length} photo URL(s) look like our /media/ store but the object is NOT in the bucket — buyers do not see them. First: ${r.missing.slice(0, 5).join(', ')}`);
  }
  await prisma.auditLog.create({
    data: { actorEmail: 'script:normalize-media-urls', action: apply ? 'media.normalize' : 'media.normalize.dryrun', meta: `products=${r.products} rewritten=${r.rewritten} missing=${r.missing.length} foreign=${r.foreign}` },
  }).catch(() => null);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
