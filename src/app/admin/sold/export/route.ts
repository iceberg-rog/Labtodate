import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { csvDocument, csvResponse, fileSlug } from '@/lib/reports/csv';
import { localDay, resolvePeriod } from '@/lib/reports/period';
import { filterSoldRows, loadSoldRows, SOLD_CSV_HEADER, soldCsvRows, soldStatusView } from '@/lib/reports/sold';

export const dynamic = 'force-dynamic';

/**
 * The Sold register as CSV, with the filters of /admin/sold (?period= or
 * ?from=/&to=, ?status=, ?category=, ?supplier=, ?q=): one row per sold line,
 * excl. VAT, with supplier cost, margin and the order's documents.
 */
export async function GET(req: Request) {
  await requireCapability('finance:export');
  await ensureSettingsLoaded();
  const sp = new URL(req.url).searchParams;
  const tz = businessTimeZone();
  const now = new Date();
  const period = resolvePeriod({ period: sp.get('period'), from: sp.get('from'), to: sp.get('to') }, now, tz);
  const rows = filterSoldRows(
    await loadSoldRows({ period, tz, status: soldStatusView(sp.get('status')), q: (sp.get('q') ?? '').trim().slice(0, 100) }, siteName()),
    { category: (sp.get('category') ?? '').trim(), supplier: (sp.get('supplier') ?? '').trim() },
  );
  const csv = csvDocument(SOLD_CSV_HEADER, soldCsvRows(rows, tz));
  return csvResponse(csv, `${fileSlug(siteName())}-sold-${fileSlug(period.label)}-${localDay(now, tz)}.csv`);
}
