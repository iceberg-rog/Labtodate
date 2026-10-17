import { NextResponse } from 'next/server';
import { searchProvider } from '@/lib/search/provider';
import { rateLimit } from '@/lib/ratelimit';
import { loadPriceDisplay } from '@/lib/pricing/server';
import { priceParts } from '@/lib/pricing/display';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  // Each hit runs several leading-wildcard ILIKE scans over the products table,
  // so guard the public endpoint: skip trivially short queries and throttle
  // scripted bursts per IP (DB-CPU protection). The limit allows for normal
  // typing from several people behind one campus/company NAT (40/min could be
  // reached by one fast typist); the client shows "busy" on a 429.
  if (q.length < 2) return NextResponse.json({ hits: [] });
  try {
    await rateLimit('typeahead', 120, 60_000);
  } catch {
    return NextResponse.json({ hits: [], error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  const limit = Math.min(10, parseInt(url.searchParams.get('limit') ?? '6', 10) || 6);

  const [raw, display, policy] = await Promise.all([searchProvider.typeahead(q, limit), loadPriceDisplay(), getCatalogPolicy()]);
  // The shown price + its VAT basis, exactly as on cards (Settings → Tax & VAT).
  const hits = raw.map((h) => {
    const p = h.priceCents ? priceParts(h.priceCents, display) : null;
    return {
      ...h,
      brand: h.brand && !isPlaceholderBrand({ name: h.brand }, policy.placeholderBrands) ? h.brand : null,
      priceCents: p ? p.primaryCents : null,
      priceLabel: p ? p.primaryLabel : null,
      noPhotoLabel: policy.noPhotoLabel,
    };
  });
  return NextResponse.json({ hits });
}
