/**
 * One-time backfill (A03): freeze every document issued BEFORE 4_business_core
 * as it renders today, under its old number (series LEGACY), so it can never
 * change again. Idempotent — run it as often as you like; already-frozen
 * documents are skipped. The download routes also freeze lazily, so a missed
 * order is still covered the first time somebody opens its document.
 *
 *   node --env-file=.env --import tsx scripts/backfill-legacy-documents.ts [--dry-run]
 *
 * PDFs are not rendered here (no Chromium needed): each frozen document is
 * rendered from its snapshot and stored on its first download.
 */
import { prisma } from '../src/lib/db';
import { documentsCutover, freezeLegacyDocuments } from '../src/lib/documents/issue';

const PAID = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'] as const;

async function main() {
  const dry = process.argv.includes('--dry-run');
  const cutover = await documentsCutover();
  if (!cutover) throw new Error('Migration 4_business_core is not applied — nothing to freeze against.');
  const orders = await prisma.order.findMany({
    where: {
      createdAt: { lt: cutover },
      OR: [
        { status: { in: [...PAID] } },
        { status: 'PENDING_PAYMENT' },
        { sourcingRequest: { proformaNumber: { not: null } } },
      ],
    },
    select: { id: true, orderNumber: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`cutover ${cutover.toISOString()} — ${orders.length} order(s) to check${dry ? ' (dry run)' : ''}`);
  if (dry) return;
  let proformas = 0;
  let invoices = 0;
  const failed: string[] = [];
  for (const o of orders) {
    try {
      const r = await freezeLegacyDocuments(o.id);
      if (r.proforma) proformas++;
      if (r.invoice) invoices++;
    } catch (e) {
      failed.push(`${o.orderNumber}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`frozen/present: ${proformas} proforma(s), ${invoices} invoice(s); failed: ${failed.length}`);
  for (const f of failed) console.log(`  ✖ ${f}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
