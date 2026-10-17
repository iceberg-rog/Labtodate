/**
 * CLI for the WooCommerce supplier sync — the SAME engine as Admin → Shops →
 * (shop) → Sync (src/lib/marketplace/woo-sync.ts). DRY RUN by default.
 *
 *   npx tsx prisma/import-woo.ts                 # dry run, every shop with an import URL
 *   npx tsx prisma/import-woo.ts --shop lab2parts # dry run, one shop
 *   npx tsx prisma/import-woo.ts --apply          # really sync
 *
 * What a run may change follows each shop's sync policy (Sync page): by
 * default only price and availability; items removed at the source are
 * archived; new items wait for review; nothing is ever deleted and archived /
 * draft items are never re-published. Every run is stored as an ImportRun
 * report you can open in the admin.
 *
 * The old version of this script upserted by slug (mixing shops that share a
 * slug), overwrote curated data, re-published archived items and DELETED every
 * product not owned by the importer. That is gone: removing fabricated seed
 * data is prisma/audit-seed-content.ts. New shops are added in the admin.
 */
import { prisma } from '../src/lib/db';
import { runWooSync } from '../src/lib/marketplace/woo-sync';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.includes('--add')) {
    console.error('`--add` was removed: add the shop in Admin → Shops & suppliers (it records the import URL, agreement and sync policy), then run this script.');
    process.exit(2);
  }
  const only = arg('--shop');
  const shops = await prisma.company.findMany({
    where: { importSourceUrl: { not: null }, ...(only ? { slug: only } : {}) },
    select: { id: true, slug: true, name: true, importSourceUrl: true },
    orderBy: { name: 'asc' },
  });
  if (!shops.length) {
    console.error(only ? `No shop "${only}" with an import URL.` : 'No shop has an import URL.');
    process.exit(1);
  }
  console.log(apply ? '⇄ SYNC (writes changes)' : '⇄ DRY RUN (nothing is written — add --apply to sync)');
  let failed = 0;
  for (const s of shops) {
    const r = await runWooSync({ companyId: s.id, dryRun: !apply, trigger: 'CLI', actorEmail: 'system:cli' });
    console.log(`\n${s.name} (${s.importSourceUrl})\n  ${r.status}: ${r.message}\n  report: /admin/companies/${s.slug}/runs/${r.runId ?? '-'}`);
    if (!r.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main()
  .catch((e) => {
    console.error('Sync failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
