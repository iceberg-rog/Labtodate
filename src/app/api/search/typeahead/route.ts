import { NextResponse } from 'next/server';
import { searchProvider } from '@/lib/search/provider';
import { rateLimit } from '@/lib/ratelimit';

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

  const hits = await searchProvider.typeahead(q, limit);
  return NextResponse.json({ hits });
}
