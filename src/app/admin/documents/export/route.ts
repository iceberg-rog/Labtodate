import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { csvDocument, csvResponse, fileSlug } from '@/lib/reports/csv';
import { localDay, resolvePeriod } from '@/lib/reports/period';
import {
  DOC_CSV_HEADER,
  docCsvRows,
  docKindFilter,
  filterDocRows,
  ICP_CSV_HEADER,
  icpCsvRows,
  icpSummary,
  loadDocRows,
  VAT_CSV_HEADER,
  vatCsvRows,
  vatSummary,
} from '@/lib/reports/documents';

export const dynamic = 'force-dynamic';

/**
 * Accounting exports of /admin/documents, with its filters (?period= or
 * ?from=/&to=, ?kind=, ?treatment=, ?currency=, ?q=):
 *   ?view=register (default)  one row per document and VAT rate
 *   ?view=vat[&by=month]      VAT summary per quarter (or month), treatment and rate
 *   ?view=icp                 ICP listing: intra-EU 0% per quarter and buyer VAT ID
 */
export async function GET(req: Request) {
  await requireCapability('finance:export');
  await ensureSettingsLoaded();
  const sp = new URL(req.url).searchParams;
  const tz = businessTimeZone();
  const now = new Date();
  const view = sp.get('view') === 'vat' || sp.get('view') === 'icp' ? sp.get('view')! : 'register';
  const period = resolvePeriod({ period: sp.get('period'), from: sp.get('from'), to: sp.get('to') }, now, tz);
  const rows = filterDocRows(await loadDocRows(period, tz), {
    kind: view === 'register' ? docKindFilter(sp.get('kind')) : 'fiscal',
    treatment: view === 'icp' ? '' : (sp.get('treatment') ?? '').trim(),
    currency: (sp.get('currency') ?? '').trim().toUpperCase(),
    q: (sp.get('q') ?? '').trim().slice(0, 100),
  });
  const csv =
    view === 'vat'
      ? csvDocument(VAT_CSV_HEADER, vatCsvRows(vatSummary(rows, sp.get('by') === 'month' ? 'month' : 'quarter')))
      : view === 'icp'
        ? csvDocument(ICP_CSV_HEADER, icpCsvRows(icpSummary(rows)))
        : csvDocument(DOC_CSV_HEADER, docCsvRows(rows));
  const name = view === 'vat' ? 'vat-summary' : view === 'icp' ? 'icp' : 'documents';
  return csvResponse(csv, `${fileSlug(siteName())}-${name}-${fileSlug(period.label)}-${localDay(now, tz)}.csv`);
}
