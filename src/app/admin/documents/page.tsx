import Link from 'next/link';
import { Download, Files } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminPager } from '@/components/admin/AdminListControls';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { businessTimeZone } from '@/lib/documents/numbering';
import { documentNumberHref } from '@/lib/documents';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { formatPrice } from '@/lib/utils';
import { PERIOD_OPTIONS, periodKeyLabel, periodParams, resolvePeriod } from '@/lib/reports/period';
import {
  docKindFilter,
  docKindShort,
  filterDocRows,
  icpSummary,
  loadDocRows,
  rateTotals,
  vatLineLabel,
  vatSummary,
  type DocKindFilter,
  type DocRow,
  type RateTotal,
} from '@/lib/reports/documents';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents' };

const PAGE_SIZE = 100;

const VIEWS = [
  { key: 'register', label: 'Register' },
  { key: 'vat', label: 'VAT summary' },
  { key: 'icp', label: 'ICP (intra-EU 0%)' },
] as const;
type View = (typeof VIEWS)[number]['key'];

const KINDS: Array<{ key: DocKindFilter; label: string }> = [
  { key: 'all', label: 'All documents' },
  { key: 'fiscal', label: 'Invoices + credit notes' },
  { key: 'INVOICE', label: 'Invoices' },
  { key: 'CREDIT_NOTE', label: 'Credit notes' },
  { key: 'PROFORMA', label: 'Proformas' },
];

type Search = { view?: string; period?: string; from?: string; to?: string; kind?: string; treatment?: string; currency?: string; q?: string; by?: string; page?: string };

/** The rate / line cell; a margin VAT line that misses units says so. */
function lineCell(t: Pick<RateTotal, 'line' | 'rateBp' | 'incompleteDocs'>): string {
  const label = vatLineLabel(t.line, t.rateBp);
  return t.line === 'margin-vat' && t.incompleteDocs > 0
    ? `${label} — incomplete: ${t.incompleteDocs} document${t.incompleteDocs === 1 ? '' : 's'} with a unit without a purchase cost`
    : label;
}

const MARGIN_NOTE =
  ' Margin scheme (second-hand goods): the invoice prints VAT on the freight only; the VAT on the margin is inside the goods price and is never printed. "Margin VAT owed" is computed per unit from the sale price and the recorded purchase cost at the standard VAT rate in Settings → Tax & VAT (the rate the invoice used, unless it was changed since): its net is the taxable margin excl. VAT, its VAT the amount to declare. The goods line is the sale price itself, not a VAT base. A unit without a purchase cost has no known margin VAT and is not included — record the cost and check that line.';

export default async function AdminDocumentsPage(props: { searchParams: Promise<Search> }) {
  const sp = await props.searchParams;
  await requireCapability('finance:view', { redirectTo: '/admin/documents' });
  await ensureSettingsLoaded();
  const canExport = await hasCapability('finance:export');
  const tz = businessTimeZone();
  const view: View = sp.view === 'vat' || sp.view === 'icp' ? sp.view : 'register';
  const period = resolvePeriod(sp, new Date(), tz);
  const kind = docKindFilter(sp.kind);
  const treatment = (sp.treatment ?? '').trim();
  const currency = (sp.currency ?? '').trim().toUpperCase();
  const q = (sp.q ?? '').trim().slice(0, 100);
  const by = sp.by === 'month' ? 'month' : 'quarter';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  const all = await loadDocRows(period, tz);
  const treatments = [...new Set(all.map((r) => r.treatment))].sort();
  const currencies = [...new Set(all.map((r) => r.currency))].sort();
  // The ICP is the intra-EU 0% treatment by definition: a treatment filter from another view does not apply.
  const rows = filterDocRows(all, { kind: view === 'register' ? kind : 'fiscal', treatment: view === 'icp' ? '' : treatment, currency, q });

  const params: Record<string, string | undefined> = {
    view: view === 'register' ? undefined : view,
    ...periodParams(period),
    kind: kind === 'all' ? undefined : kind,
    treatment: treatment || undefined,
    currency: currency || undefined,
    q: q || undefined,
    by: view === 'vat' && by === 'month' ? 'month' : undefined,
  };
  const href = (over: Record<string, string | undefined>, path = '/admin/documents') => {
    const s = new URLSearchParams(Object.entries({ ...params, ...over }).filter((e): e is [string, string] => !!e[1])).toString();
    return s ? `${path}?${s}` : path;
  };
  const day = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(d);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totals = rateTotals(rows);
  const vat = view === 'vat' ? vatSummary(rows, by) : [];
  const icp = view === 'icp' ? icpSummary(rows) : [];
  const counts = { PROFORMA: 0, INVOICE: 0, CREDIT_NOTE: 0 };
  for (const r of rows) counts[r.kind] += 1;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Documents</h1>
          <p className="text-muted-foreground mt-1">
            {period.label} · {counts.INVOICE} invoice{counts.INVOICE === 1 ? '' : 's'} · {counts.CREDIT_NOTE} credit note{counts.CREDIT_NOTE === 1 ? '' : 's'}
            {view === 'register' && <> · {counts.PROFORMA} proforma{counts.PROFORMA === 1 ? '' : 's'}</>}
          </p>
        </div>
        {canExport && (
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <a href={href({ view }, '/admin/documents/export')}>
              <Download className="h-4 w-4 mr-1.5" /> Export {view === 'vat' ? 'VAT summary' : view === 'icp' ? 'ICP listing' : 'register'} (CSV)
            </a>
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1 w-fit">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={href({ view: v.key === 'register' ? undefined : v.key, page: undefined })}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${view === v.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {v.label}
          </Link>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <PillRow label="Period">
          {PERIOD_OPTIONS.map((o) => (
            <Pill key={o.key} href={href({ period: o.key === 'all' ? undefined : o.key, from: undefined, to: undefined })} active={period.key === o.key}>
              {o.label}
            </Pill>
          ))}
          {period.key === 'custom' && <Pill href={href({})} active>{period.label}</Pill>}
        </PillRow>
        {view === 'register' && (
          <PillRow label="Kind">
            {KINDS.map((k) => (
              <Pill key={k.key} href={href({ kind: k.key === 'all' ? undefined : k.key })} active={kind === k.key}>
                {k.label}
              </Pill>
            ))}
          </PillRow>
        )}
        {view === 'vat' && (
          <PillRow label="Per">
            <Pill href={href({ by: undefined })} active={by === 'quarter'}>Quarter</Pill>
            <Pill href={href({ by: 'month' })} active={by === 'month'}>Month</Pill>
          </PillRow>
        )}
        <form method="GET" className="flex gap-2 flex-wrap items-end text-sm">
          {view !== 'register' && <input type="hidden" name="view" value={view} />}
          {view === 'register' && kind !== 'all' && <input type="hidden" name="kind" value={kind} />}
          {view === 'vat' && by === 'month' && <input type="hidden" name="by" value="month" />}
          {period.key !== 'custom' && period.key !== 'all' && <input type="hidden" name="period" value={period.key} />}
          <Field label="From">
            <input type="date" name="from" defaultValue={period.key === 'custom' ? (period.from ?? '') : ''} className="h-9 px-2 rounded-lg border border-input bg-background" />
          </Field>
          <Field label="To">
            <input type="date" name="to" defaultValue={period.key === 'custom' ? (period.to ?? '') : ''} className="h-9 px-2 rounded-lg border border-input bg-background" />
          </Field>
          {view !== 'icp' && (
            <Field label="VAT treatment">
              <select name="treatment" defaultValue={treatment} className="h-9 px-2 rounded-lg border border-input bg-background max-w-[260px]">
                <option value="">All treatments</option>
                {treatments.map((t) => (
                  <option key={t} value={t}>{vatTreatmentLabel(t)}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Currency">
            <select name="currency" defaultValue={currency} className="h-9 px-2 rounded-lg border border-input bg-background">
              <option value="">All</option>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input name="q" defaultValue={q} placeholder="Number, order, buyer, VAT ID…" className="h-9 px-2 rounded-lg border border-input bg-background min-w-[220px]" />
          </Field>
          <Button type="submit" size="sm" className="rounded-full font-semibold">Apply</Button>
          {(treatment || currency || q || period.key === 'custom') && (
            <a href={href({ treatment: undefined, currency: undefined, q: undefined, from: undefined, to: undefined })} className="inline-flex items-center px-3 h-9 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10">
              Clear
            </a>
          )}
        </form>
        <p className="text-[11px] text-muted-foreground">
          Documents are dated by their issue day in the business time zone ({tz}). Amounts are as issued: a document never changes after it was sent.
        </p>
      </div>

      {view === 'register' && (
        <>
          {totals.length > 0 && (
            <section>
              <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground mb-2">Totals per VAT rate · invoices minus credit notes</h2>
              <AmountTable
                head={['Currency', 'VAT treatment', 'Rate / line', 'Net', 'VAT', 'Gross']}
                rows={totals.map((t) => [
                  t.currency,
                  vatTreatmentLabel(t.treatment),
                  lineCell(t),
                  formatPrice(t.baseCents, t.currency),
                  formatPrice(t.taxCents, t.currency),
                  t.line === 'margin-vat' ? '—' : formatPrice(t.baseCents + t.taxCents, t.currency),
                ])}
                warn={totals.map((t) => t.line === 'margin-vat' && t.incompleteDocs > 0)}
              />
              {totals.some((t) => t.line !== 'vat') && <p className="text-[11px] text-muted-foreground mt-2">{MARGIN_NOTE.trim()}</p>}
            </section>
          )}
          {rows.length === 0 ? (
            <Empty text="No documents in this selection." />
          ) : (
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-3 font-bold">Number</th>
                      <th className="px-4 py-3 font-bold">Date</th>
                      <th className="px-4 py-3 font-bold">Order · credits</th>
                      <th className="px-4 py-3 font-bold">Buyer</th>
                      <th className="px-4 py-3 font-bold">VAT</th>
                      <th className="px-4 py-3 font-bold text-right">Per rate (net / VAT)</th>
                      <th className="px-4 py-3 font-bold text-right">Net</th>
                      <th className="px-4 py-3 font-bold text-right">VAT</th>
                      <th className="px-4 py-3 font-bold text-right">Gross</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pageRows.map((r) => (
                      <DocLine key={r.id} r={r} day={day} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <AdminPager basePath="/admin/documents" page={page} totalPages={totalPages} total={rows.length} params={params} />
        </>
      )}

      {view === 'vat' && (
        <section className="space-y-3">
          {vat.length === 0 ? (
            <Empty text="No invoices or credit notes in this selection." />
          ) : (
            <AmountTable
              head={[by === 'month' ? 'Month' : 'Quarter', 'Currency', 'VAT treatment', 'Rate / line', 'Net', 'VAT', 'Invoices', 'Credit notes']}
              warn={vat.map((v) => v.line === 'margin-vat' && v.incompleteDocs > 0)}
              rows={vat.map((v) => [
                periodKeyLabel(v.period),
                v.currency,
                vatTreatmentLabel(v.treatment),
                lineCell(v),
                formatPrice(v.baseCents, v.currency),
                formatPrice(v.taxCents, v.currency),
                String(v.invoices),
                String(v.creditNotes),
              ])}
            />
          )}
          <Note>
            Invoices minus credit notes, per {by} of the issue date. Proformas are payment requests and are not counted.
            {vat.some((v) => v.line !== 'vat') && MARGIN_NOTE}
            {vat.some((v) => v.currency !== 'EUR') && ' Amounts in another currency than EUR are shown as invoiced: convert them for the VAT return at the exchange rate that applies to each invoice date (no rate is stored here).'}
          </Note>
        </section>
      )}

      {view === 'icp' && (
        <section className="space-y-3">
          {icp.length === 0 ? (
            <Empty text="No intra-EU 0% (reverse-charge) invoices in this selection." />
          ) : (
            <AmountTable
              head={['Quarter', 'Country', 'Buyer VAT ID', 'Buyer', 'Amount', 'Invoices', 'Credit notes']}
              rows={icp.map((r) => [
                periodKeyLabel(r.quarter),
                r.country ?? '—',
                r.vatId ?? 'MISSING — add the buyer VAT ID',
                r.buyer || '—',
                formatPrice(r.netCents, r.currency),
                String(r.invoices),
                String(r.creditNotes),
              ])}
              warn={icp.map((r) => !r.vatId || r.currency !== 'EUR')}
            />
          )}
          <Note>
            Intra-Community supplies of goods at 0% (reverse charge), per quarter and buyer VAT ID, for the ICP listing. Credit notes reduce the quarter in which they were issued.
            {icp.some((r) => r.currency !== 'EUR') && ' Rows in another currency than EUR must be converted to EUR before filing.'}
          </Note>
        </section>
      )}
    </div>
  );
}

function DocLine({ r, day }: { r: DocRow; day: (d: Date) => string }) {
  const kindTone =
    r.kind === 'INVOICE'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
      : r.kind === 'CREDIT_NOTE'
        ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
        : 'bg-muted text-muted-foreground border-border';
  return (
    <tr className={`align-top hover:bg-foreground/[0.02] ${r.state !== 'issued' ? 'opacity-60' : ''}`}>
      <td className="px-4 py-3 whitespace-nowrap">
        <a href={documentNumberHref(r.number)} target="_blank" rel="noopener" className="font-mono text-xs font-semibold hover:underline">
          {r.number}
        </a>
        <p className="mt-1 flex gap-1 flex-wrap">
          <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${kindTone}`}>{docKindShort(r.kind)}</span>
          {r.state !== 'issued' && <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{r.state}</span>}
          {r.legacy && <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">legacy</span>}
        </p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap tabular-nums">{day(r.issueDate)}</td>
      <td className="px-4 py-3 whitespace-nowrap text-xs">
        {r.orderId && r.orderNumber ? (
          <Link href={`/admin/orders/${r.orderId}`} className="font-mono font-semibold hover:underline">{r.orderNumber}</Link>
        ) : (
          <span className="font-mono">{r.orderNumber ?? '—'}</span>
        )}
        {r.originalNumber && <p className="text-muted-foreground">credits <span className="font-mono">{r.originalNumber}</span></p>}
      </td>
      <td className="px-4 py-3 min-w-[180px]">
        <p className="font-semibold">{r.buyer.company ?? r.buyer.name ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground font-mono">{[r.buyer.vatId, r.buyer.country].filter(Boolean).join(' · ') || '—'}</p>
      </td>
      <td className="px-4 py-3 text-xs min-w-[160px]">{vatTreatmentLabel(r.treatment)}</td>
      <td className="px-4 py-3 text-right text-xs tabular-nums whitespace-nowrap">
        {r.rates.map((x, i) => (
          <p key={i}>
            <span className="text-muted-foreground">{x.line === 'margin-goods' ? 'margin goods' : vatLineLabel(x.line, x.rateBp)}</span> {formatPrice(x.baseCents, r.currency)} / {formatPrice(x.taxCents, r.currency)}
          </p>
        ))}
        {r.treatment === 'MARGIN_SCHEME' && r.kind !== 'PROFORMA' && (
          <p className={r.marginVat && !r.marginVat.unitsWithoutCost ? 'text-muted-foreground' : 'font-semibold text-amber-700 dark:text-amber-300'}>
            margin VAT owed (not printed) {r.marginVat ? formatPrice(r.marginVat.vatCents, r.currency) : 'not computed'}
            {r.marginVat && r.marginVat.unitsWithoutCost > 0 && ` · ${r.marginVat.unitsWithoutCost} unit${r.marginVat.unitsWithoutCost === 1 ? '' : 's'} without a purchase cost, not included`}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(r.netCents, r.currency)}</td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(r.taxCents, r.currency)}</td>
      <td className="px-4 py-3 text-right font-bold tabular-nums whitespace-nowrap">{formatPrice(r.totalCents, r.currency)}</td>
    </tr>
  );
}

function AmountTable({ head, rows, warn }: { head: string[]; rows: string[][]; warn?: boolean[] }) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
              {head.map((h) => (
                <th key={h} className="px-4 py-2.5 font-bold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i} className={warn?.[i] ? 'bg-amber-50/60 dark:bg-amber-950/30' : ''}>
                {r.map((c, j) => (
                  <td key={j} className="px-4 py-2 tabular-nums whitespace-nowrap">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
      <Files className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
      <p className="text-lg font-semibold">{text}</p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-border bg-foreground/[0.02] p-4 text-xs text-muted-foreground">{children}</p>;
}

function PillRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 flex-wrap items-center">
      <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mr-1 min-w-[64px]">{label}</span>
      {children}
    </div>
  );
}

function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold ${active ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-foreground hover:bg-foreground/10'}`}
    >
      {children}
    </Link>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
