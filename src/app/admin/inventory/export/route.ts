import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAdminCaps, requireCapability } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { audit } from '@/lib/observability';
import { buildCsv, buildXlsx } from '@/lib/inventory/export';
import { loadExportPhotos } from '@/lib/inventory/export-photos';
import { loadInventoryRows } from '@/lib/inventory/rows';

export const dynamic = 'force-dynamic';

async function handle(params: { format: string; scope: string; ids: string }) {
  const session = await requireCapability('inventory:view');
  const caps = await getAdminCaps();
  const canCost = capsAllow(caps, 'inventory:cost');
  const format = params.format === 'csv' ? 'csv' : 'xlsx';
  const withPhotos = params.format !== 'xlsx-plain';   // 'xlsx-plain': the workbook without photos (small, for re-importing)
  const ids = params.ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9]{6,64}$/i.test(s))
    .slice(0, 10000);
  const rows = await loadInventoryRows({ scope: params.scope === 'all' ? 'all' : 'own', ids: ids.length ? ids : undefined, canCost });
  const siteUrl = (process.env.BETTER_AUTH_URL || 'https://labtodate.com').replace(/\/+$/, '');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  await audit('inventory.export', format, `${rows.length} rows${canCost ? ' incl. cost' : ''}${format === 'xlsx' && withPhotos ? ' with photos' : ''}`);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (format === 'csv') {
    return new NextResponse(buildCsv(rows, { canCost, siteUrl }), {
      headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="labtodate-inventory-${stamp}.csv"` },
    });
  }
  // each row's main photo, embedded at its original quality (export-photos.ts)
  const [suppliers, categories, { photos }] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.category.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
    withPhotos ? loadExportPhotos(rows) : Promise.resolve({ photos: undefined }),
  ]);
  const buf = await buildXlsx(rows, {
    canCost,
    suppliers: suppliers.map((s) => s.name),
    categories: categories.map((c) => c.name),
    siteUrl,
    exportedBy: session.user.email,
    photos,
  });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      ...headers,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="labtodate-inventory-${stamp}.xlsx"`,
    },
  });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle({ format: u.searchParams.get('format') ?? 'xlsx', scope: u.searchParams.get('scope') ?? 'own', ids: u.searchParams.get('ids') ?? '' });
}

export async function POST(req: Request) {
  const f = await req.formData();
  return handle({ format: String(f.get('format') ?? 'xlsx'), scope: String(f.get('scope') ?? 'own'), ids: String(f.get('ids') ?? '') });
}
