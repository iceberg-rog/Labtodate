import { cache } from 'react';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getSiteTexts, siteClaims } from '@/lib/site/content';

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

// Financing has no admin text yet: unset renders nothing rather than an
// unsupported claim. Claims, tagline and social links: see getMarketing().
const D = {
  financing: '',
};

/** Cached per-request: real DB counts for marketing fallbacks. Cheap, but
 *  cache() de-dupes when getMarketing is called from multiple components in
 *  the same render. Safe-fails when called during `next build` static export
 *  (no DB connection) — returns zeros so the page can still pre-render. */
const getRealCounts = cache(async () => {
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
  const [real, claims, texts] = await Promise.all([
    needCounts ? getRealCounts() : Promise.resolve({ listings: 0, suppliers: 0 }),
    // Claims, tagline and social links are edited in Admin → Site content
    // (a switched-off claim is '' here, so every consumer drops its sentence).
    siteClaims(),
    getSiteTexts(),
  ]);
  return {
    listings: adminListings || String(real.listings),
    suppliers: adminSuppliers || String(real.suppliers),
    quoteTurnaround: claims.quoteTurnaround,
    warranty: claims.warranty,
    inspection: claims.inspection,
    financing: process.env.FINANCING_TEXT === undefined ? D.financing : (process.env.FINANCING_TEXT?.trim() || ''),
    footerTagline: (texts['footer.tagline'] ?? '').trim(),
    social: {
      linkedin: (texts['footer.linkedin'] ?? '').trim(),
      twitter: (texts['footer.twitter'] ?? '').trim(),
      github: (texts['footer.github'] ?? '').trim(),
    },
  };
}
