/**
 * Retired. This one-off importer upserted lab2parts.com by slug, overwrote
 * curated data and re-published archived items on every run.
 *
 * Use the supplier sync instead (same engine as the admin Sync page):
 *   npx tsx prisma/import-woo.ts --shop lab2parts            # dry run
 *   npx tsx prisma/import-woo.ts --shop lab2parts --apply    # sync
 */
console.error('prisma/import-lab2parts.ts is retired — use: npx tsx prisma/import-woo.ts --shop lab2parts [--apply]');
process.exit(2);
