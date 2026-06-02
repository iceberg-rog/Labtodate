/**
 * Fetch official brand logos (Clearbit Logo API), store them in our own
 * MinIO so the live site has no external dependency, and set
 * Brand.logoUrl. Idempotent. One-time / re-runnable.
 *
 *   npx tsx prisma/fetch-brand-logos.ts
 */

import { PrismaClient } from '@prisma/client';
import { uploadObject, ensureBucket } from '../src/lib/storage/s3';

const prisma = new PrismaClient();

// brand name → primary domain for the logo lookup
const DOMAINS: Record<string, string> = {
  Agilent: 'agilent.com',
  Waters: 'waters.com',
  Thermo: 'thermofisher.com',
  'Thermo Fisher': 'thermofisher.com',
  Shimadzu: 'shimadzu.com',
  'Hewlett-Packard': 'hp.com',
  PerkinElmer: 'perkinelmer.com',
  Dionex: 'thermofisher.com',
  Varian: 'agilent.com',
  Bruker: 'bruker.com',
  Sciex: 'sciex.com',
  Beckman: 'beckman.com',
  Sartorius: 'sartorius.com',
  Eppendorf: 'eppendorf.com',
  'Bio-Rad': 'bio-rad.com',
  Mettler: 'mt.com',
  Tecan: 'tecan.com',
  Roche: 'roche.com',
  Leica: 'leica-microsystems.com',
  Zeiss: 'zeiss.com',
  Olympus: 'olympus-lifescience.com',
  Nikon: 'nikon.com',
};

async function main() {
  await ensureBucket();
  const brands = await prisma.brand.findMany({ select: { id: true, name: true, slug: true } });

  let ok = 0;
  let skip = 0;
  for (const b of brands) {
    const domain = DOMAINS[b.name];
    if (!domain) { skip++; continue; }
    const sources = [
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      `https://www.google.com/s2/favicons?sz=128&domain=${domain}`,
    ];
    let done = false;
    for (const src of sources) {
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || 'image/png';
        if (!ct.startsWith('image/')) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 120) continue;
        const ext = ct.includes('svg') ? 'svg' : ct.includes('png') ? 'png' : ct.includes('icon') ? 'ico' : 'png';
        const { url } = await uploadObject(`brands/${b.slug}.${ext}`, buf, ct);
        await prisma.brand.update({ where: { id: b.id }, data: { logoUrl: url } });
        console.log(`  ✓ ${b.name} → ${url}`);
        ok++;
        done = true;
        break;
      } catch {
        /* try next source */
      }
    }
    if (!done) { console.warn(`  ! ${b.name} (${domain}) — no logo source worked`); skip++; }
  }
  console.log(`\n✅ Logos stored: ${ok} · skipped: ${skip}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
