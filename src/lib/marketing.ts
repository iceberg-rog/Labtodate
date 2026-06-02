import { cache } from 'react';
import { prisma } from '@/lib/db';
import { isBuildPhase } from '@/lib/build-phase';
import { ensureSettingsLoaded } from '@/lib/settings';

export interface Marketing {
  listings: string;
  suppliers: string;
  quoteTurnaround: string;
  warranty: string;
  inspection: string;
  financing: string;
  footerTagline: string;
  social: { linkedin: string; twitter: string; github: string };
}

const D = {
  quoteTurnaround: '5 business days',
  warranty: '90-day warranty',
  inspection: '14-point inspection',
  financing: 'Financing available · 0% for 12 months on approved business credit',
  footerTagline:
    'B2B marketplace for new & certified refurbished laboratory and biotech equipment. Pairing business with science.',
};

/** Cached per-request: real DB counts for marketing fallbacks. Cheap, but
 *  cache() de-dupes when getMarketing is called from multiple components in
 *  the same render. Safe-fails when called during `next build` static export
 *  (no DB connection) — returns zeros so the page can still pre-render. */
const getRealCounts = cache(async () => {
  if (isBuildPhase()) return { listings: 0, suppliers: 0 };
  try {
    const [listings, suppliers] = await Promise.all([
      prisma.product.count({ where: { status: 'PUBLISHED' } }),
      prisma.company.count(),
    ]);
    return { listings, suppliers };
  } catch {
    return { listings: 0, suppliers: 0 };
  }
});

/** Admin-configurable marketing copy. STAT_LISTINGS / STAT_SUPPLIERS in
 *  settings override; otherwise we fall back to real DB counts so the site
 *  never quotes numbers that aren't backed by data. */
export async function getMarketing(): Promise<Marketing> {
  await ensureSettingsLoaded();
  const adminListings = process.env.STAT_LISTINGS?.trim() || '';
  const adminSuppliers = process.env.STAT_SUPPLIERS?.trim() || '';
  const needCounts = !adminListings || !adminSuppliers;
  const real = needCounts ? await getRealCounts() : { listings: 0, suppliers: 0 };
  return {
    listings: adminListings || String(real.listings),
    suppliers: adminSuppliers || String(real.suppliers),
    quoteTurnaround: process.env.QUOTE_TURNAROUND?.trim() || D.quoteTurnaround,
    warranty: process.env.WARRANTY_TEXT?.trim() || D.warranty,
    inspection: process.env.INSPECTION_TEXT?.trim() || D.inspection,
    financing: process.env.FINANCING_TEXT === undefined ? D.financing : (process.env.FINANCING_TEXT?.trim() || ''),
    footerTagline: process.env.FOOTER_TAGLINE?.trim() || D.footerTagline,
    social: {
      linkedin: process.env.SOCIAL_LINKEDIN?.trim() || '',
      twitter: process.env.SOCIAL_TWITTER?.trim() || '',
      github: process.env.SOCIAL_GITHUB?.trim() || '',
    },
  };
}
