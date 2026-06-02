import { NextResponse } from 'next/server';
import { searchProvider } from '@/lib/search/provider';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const limit = Math.min(10, parseInt(url.searchParams.get('limit') ?? '6', 10) || 6);

  const hits = await searchProvider.typeahead(q, limit);
  return NextResponse.json({ hits });
}
