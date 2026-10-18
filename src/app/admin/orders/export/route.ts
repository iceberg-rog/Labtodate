import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { csvDocument, csvResponse, fileSlug } from '@/lib/reports/csv';
import { localDay } from '@/lib/reports/period';
import { ORDER_CSV_HEADER, ORDER_EXPORT_INCLUDE, orderCsvRow } from '@/lib/reports/orders-export';

export const dynamic = 'force-dynamic';

/**
 * Streams a UTF-8 CSV of orders (Excel-friendly with BOM) for accounting /
 * external book-keeping. Honours ?range= (7d|30d|90d|all) — defaults to all —
 * and ?ids=a,b,c (the list's "Export N" for selected rows), which restricts
 * the export to exactly those orders. Columns: lib/reports/orders-export.ts
 * (incl. PO, proforma, invoice number / date, VAT treatment / rate / amount,
 * buyer VAT ID and credit notes).
 */
export async function GET(req: Request) {
  await requireCapability('orders:view');
  await ensureSettingsLoaded();
  const tz = businessTimeZone();
  const url = new URL(req.url);
  const range = url.searchParams.get('range');
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 1000);

  const where = {
    ...(days ? { createdAt: { gte: new Date(Date.now() - days * 864e5) } } : {}),
    ...(ids.length > 0 ? { id: { in: ids } } : {}),
  };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: ORDER_EXPORT_INCLUDE,
  });

  const filename = `${fileSlug(siteName())}-orders${ids.length > 0 ? `-selected-${orders.length}` : range ? `-${range}` : ''}-${localDay(new Date(), tz)}.csv`;
  return csvResponse(csvDocument(ORDER_CSV_HEADER, orders.map((o) => orderCsvRow(o, tz))), filename);
}
