/**
 * Remove supplier claims (its warranty, "tested by our engineers", "like new",
 * services), other prices and "Also available" cross-sell tails from the texts
 * of supplier listings — the same rules (Settings → Import & suppliers) and
 * the same code (src/lib/catalog/audit.ts) as Admin → Catalog → Audit →
 * "Clean texts". Only those sentences go; the technical text stays. Texts an
 * admin edited (locked) are reported, never changed. Idempotent.
 *
 *   node --env-file=.env --import tsx scripts/clean-imported-claims.ts          # dry run (report)
 *   node --env-file=.env --import tsx scripts/clean-imported-claims.ts --apply
 */
import { prisma } from '../src/lib/db';
import { getImportSettings } from '../src/lib/catalog/import-settings';
import { cleanSupplierTexts } from '../src/lib/catalog/audit';

async function main() {
  const apply = process.argv.includes('--apply');
  const rules = await getImportSettings();
  const r = await cleanSupplierTexts(prisma, rules, { apply });
  console.log(
    `${apply ? 'Applied' : 'Dry run'}: ${r.checked} supplier listing(s) checked, ${r.cleaned} ${apply ? 'cleaned' : 'would be cleaned'}, ` +
      `${r.sentences} sentence(s) ${apply ? 'removed' : 'to remove'} ${JSON.stringify(r.byReason)}; ${r.skippedLocked} with admin-edited texts left alone.`,
  );
  for (const s of r.samples.slice(0, 8)) {
    console.log(`  ${s.slug}: ${s.removed.map((x) => `[${x.reason}] ${x.text.slice(0, 90)}`).join(' | ')}`);
  }
  if (apply) {
    await prisma.auditLog.create({
      data: { actorEmail: 'script:clean-imported-claims', action: 'catalog.audit.clean', meta: `checked=${r.checked} cleaned=${r.cleaned} sentences=${r.sentences} ${JSON.stringify(r.byReason)}` },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
