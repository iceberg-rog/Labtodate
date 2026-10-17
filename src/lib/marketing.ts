import { cache } from 'react';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { CATALOG_TEXT_DEFAULTS } from '@/lib/catalog/texts';

export interface Marketing {
  listings: string;
  suppliers: string;
  quoteTurnaround: string;
  financing: string;
  footerTagline: string;
  footerSignoff: string;
  /** What a sourcing request commits the buyer to (SOURCING_NO_OBLIGATION_TEXT). */
  noObligation: string;
  social: { linkedin: string; twitter: string; github: string };
}

// Defaults are intentionally empty so unset settings render nothing rather
// than an unsupported claim. There is deliberately NO site-wide warranty or
// inspection text any more (the old WARRANTY_TEXT / INSPECTION_TEXT env keys
// are ignored): warranty and inspection are per item / per condition grade —
// see src/lib/catalog/warranty.ts and Admin → Catalog → Conditions & warranty.
const D = {
  quoteTurnaround: '',
  financing: '',
  footerTagline: CATALOG_TEXT_DEFAULTS.footerTagline,
  noObligation: CATALOG_TEXT_DEFAULTS.sourcingNoObligation,
};

/** Cached per-request: real DB counts for marketing fallbacks. Cheap, but
 *  cache() de-dupes when getMarketing is called from multiple components in
 *  the same render. Safe-fails when called during `next build` static export
 *  (no DB connection) — returns zeros so the page can still pre-render. */
const getRealCounts = cache(async () => {
  try {
    // The same count as the marketplace and the hero (what a buyer can browse),
    // and only suppliers with a signed agreement (an onboarded supplier).
    const [listings, suppliers] = await Promise.all([
      prisma.product.count({ where: LIVE_PRODUCT_WHERE }),
      prisma.company.count({ where: { agreementStatus: 'SIGNED', products: { some: LIVE_PRODUCT_WHERE } } }),
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
    financing: process.env.FINANCING_TEXT === undefined ? D.financing : (process.env.FINANCING_TEXT?.trim() || ''),
    footerTagline: process.env.FOOTER_TAGLINE?.trim() || D.footerTagline,
    footerSignoff: process.env.FOOTER_SIGNOFF?.trim() || '',
    noObligation: process.env.SOURCING_NO_OBLIGATION_TEXT?.trim() || D.noObligation,
    social: {
      linkedin: process.env.SOCIAL_LINKEDIN?.trim() || '',
      twitter: process.env.SOCIAL_TWITTER?.trim() || '',
      github: process.env.SOCIAL_GITHUB?.trim() || '',
    },
  };
}
