import Link from 'next/link';
import { Download, PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminPager } from '@/components/admin/AdminListControls';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { documentNumberHref } from '@/lib/documents';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/orders/display';
import { formatPrice } from '@/lib/utils';
import { PERIOD_OPTIONS, periodParams, resolvePeriod } from '@/lib/reports/period';
import {
  filterSoldRows,
  loadSoldRows,
  SOLD_STATUS_VIEWS,
  soldFilterOptions,
  soldStatusView,
  soldTotals,
  type SoldRow,
  type SoldStatusView,
} from '@/lib/reports/sold';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sold items' };

const PAGE_SIZE = 100;

const TONE_BADGE: Record<string, string> = {
  amber: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  sky: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  violet: 'bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800',
  red: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  slate: 'bg-muted text-muted-foreground border-border',
};

type Search = { period?: string; from?: string; to?: string; status?: string; category?: string; supplier?: string; q?: string; page?: string };

export default async function AdminSoldPage(props: { searchParams: Promise<Search> }) {
  const sp = await props.searchParams;
  await requireCapability('finance:view', { redirectTo: '/admin/sold' });
  await ensureSettingsLoaded();
  const canExport = await hasCapability('finance:export');
  const tz = businessTimeZone();
  const period = resolvePeriod(sp, new Date(), tz);
  const status = soldStatusView(sp.status);
  const q = (sp.q ?? '').trim().slice(0, 100);
  const category = (sp.category ?? '').trim();
  const supplier = (sp.supplier ?? '').trim();
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  const all = await loadSoldRows({ period, tz, status, q }, siteName());
  const options = soldFilterOptions(all);
  const rows = filterSoldRows(all, { category, supplier });
  const totals = soldTotals(rows);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Every filter except the page, as URL parameters (links, pager, export).
  const params: Record<string, string | undefined> = {
    ...periodParams(period),
    status: status === 'sold' ? undefined : status,
    category: category || undefined,
    supplier: supplier || undefined,
    q: q || undefined,
  };
  const href = (over: Record<string, string | undefined>, path = '/admin/sold') => {
    const next = { ...params, ...over };
    const s = new URLSearchParams(Object.entries(next).filter((e): e is [string, string] => !!e[1])).toString();
    return s ? `${path}?${s}` : path;
  };
  const periodHref = (key: string) => href({ period: key === 'all' ? undefined : key, from: undefined, to: undefined });
  const day = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(d) : null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sold items</h1>
          <p className="text-muted-foreground mt-1">
            {rows.length} line{rows.length === 1 ? '' : 's'} · {period.label} · {SOLD_STATUS_VIEWS[status].label.toLowerCase()} · prices excl. VAT
          </p>
        </div>
        {canExport && (
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <a href={href({}, '/admin/sold/export')}>
              <Download className="h-4 w-4 mr-1.5" /> Export CSV
            </a>
          </Button>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <PillRow label="Period">
          {PERIOD_OPTIONS.map((o) => (
            <Pill key={o.key} href={periodHref(o.key)} active={period.key === o.key}>
              {o.label}
            </Pill>
          ))}
          {period.key === 'custom' && <Pill href={href({})} active>{period.label}</Pill>}
        </PillRow>
        <PillRow label="Status">
          {(Object.keys(SOLD_STATUS_VIEWS) as SoldStatusView[]).map((k) => (
            <Pill key={k} href={href({ status: k === 'sold' ? undefined : k })} active={status === k}>
              {SOLD_STATUS_VIEWS[k].label}
            </Pill>
          ))}
        </PillRow>
        <form method="GET" className="flex gap-2 flex-wrap items-end text-sm">
          {status !== 'sold' && <input type="hidden" name="status" value={status} />}
          {period.key !== 'custom' && period.key !== 'all' && <input type="hidden" name="period" value={period.key} />}
          <Field label="From">
            <input type="date" name="from" defaultValue={period.key === 'custom' ? (period.from ?? '') : ''} className="h-9 px-2 rounded-lg border border-input bg-background" />
          </Field>
          <Field label="To">
            <input type="date" name="to" defaultValue={period.key === 'custom' ? (period.to ?? '') : ''} className="h-9 px-2 rounded-lg border border-input bg-background" />
          </Field>
          <Field label="Category">
            <select name="category" defaultValue={category} className="h-9 px-2 rounded-lg border border-input bg-background max-w-[220px]">
              <option value="">All categories</option>
              {options.categories.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Supplier">
            <select name="supplier" defaultValue={supplier} className="h-9 px-2 rounded-lg border border-input bg-background max-w-[220px]">
              <option value="">All suppliers</option>
              {options.suppliers.map((s) => (
                <option key={s.key} value={s.key}>{s.kind === 'own' ? `${s.name} (own stock)` : s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input name="q" defaultValue={q} placeholder="Product, order, invoice, buyer…" className="h-9 px-2 rounded-lg border border-input bg-background min-w-[220px]" />
          </Field>
          <Button type="submit" size="sm" className="rounded-full font-semibold">Apply</Button>
          {(category || supplier || q || period.key === 'custom') && (
            <a href={href({ category: undefined, supplier: undefined, q: undefined, from: undefined, to: undefined })} className="inline-flex items-center px-3 h-9 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10">
              Clear
            </a>
          )}
        </form>
        <p className="text-[11px] text-muted-foreground">Custom dates override the period. Days are counted in the business time zone ({tz}).</p>
      </div>

      {totals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {totals.map((t) => (
            <div key={t.currency} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Sold · {t.currency} · excl. VAT</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{formatPrice(t.netCents, t.currency)}</p>
              <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
                {t.units} unit{t.units === 1 ? '' : 's'}
                {t.creditedCents !== 0 && <> · credit notes on these orders {formatPrice(t.creditedCents, t.currency)} (goods)</>}
              </p>
              {(t.marginVatCents !== 0 || t.marginVatUnknown > 0) && (
                <p className={`text-[11px] tabular-nums ${t.marginVatUnknown > 0 ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                  Margin scheme: {formatPrice(t.marginVatCents, t.currency)} margin VAT taken off the invoiced prices
                  {t.marginVatUnknown > 0 && <> · {t.marginVatUnknown} line{t.marginVatUnknown === 1 ? '' : 's'} without a purchase cost still include it</>}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {t.rowsWithMargin > 0
                  ? <>Margin {formatPrice(t.marginCents, t.currency)} on {t.rowsWithMargin} line{t.rowsWithMargin === 1 ? '' : 's'} with a recorded cost (cost {formatPrice(t.costCents, t.currency)})</>
                  : 'No supplier cost recorded in this currency'}
                {t.rowsWithMargin > 0 && t.rowsWithoutMargin > 0 && <> · {t.rowsWithoutMargin} without</>}
              </p>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <PackageCheck className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">Nothing sold in this selection</p>
          <p className="text-sm text-muted-foreground mt-1">A line appears here once its order is paid or invoiced on terms.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-bold">Sold</th>
                  <th className="px-4 py-3 font-bold">Product</th>
                  <th className="px-4 py-3 font-bold">Buyer</th>
                  <th className="px-4 py-3 font-bold text-right">Excl. VAT</th>
                  <th className="px-4 py-3 font-bold">Supplier · cost</th>
                  <th className="px-4 py-3 font-bold text-right">Margin</th>
                  <th className="px-4 py-3 font-bold">Order</th>
                  <th className="px-4 py-3 font-bold">Documents</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageRows.map((r) => (
                  <SoldLine key={r.itemId} r={r} day={day} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AdminPager basePath="/admin/sold" page={page} totalPages={totalPages} total={rows.length} params={params} />

      <div className="rounded-2xl border border-border bg-foreground/[0.02] p-5 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">How this register counts</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>One row per order line once the order is <strong>paid</strong>, or <strong>invoiced on terms</strong> (sold, money still due). The sale date is whichever came first; the period filters on it.</li>
          <li>Prices are the agreed price excl. VAT and freight. Margin-scheme goods are invoiced with the VAT on the margin inside the price: it is taken off here (computed from the purchase cost; without one it cannot be, and the line says so).</li>
          <li>Credit notes are listed per order with their goods part excl. VAT; the totals and the CSV count them once per order (in the CSV on the order&apos;s first line). A corrected invoice replaces the old one: the old invoice and the credit note that cancelled it net out and carry no amount.</li>
          <li>Supplier cost comes from the supplier price behind the accepted offer, the supplier&apos;s price before the shop markup, or the recorded purchase cost of own stock. A margin is shown only when the cost is in the same currency as the sale.</li>
          <li>Amounts in different currencies are never added up.</li>
        </ul>
      </div>
    </div>
  );
}

function SoldLine({ r, day }: { r: SoldRow; day: (d: Date | null) => string | null }) {
  const tone = TONE_BADGE[STATUS_TONE[r.status] ?? 'slate'];
  return (
    <tr className="align-top hover:bg-foreground/[0.02]">
      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
        <p className="font-semibold">{day(r.saleAt) ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground">{r.onTerms ? 'on terms · not paid yet' : `paid ${day(r.paidAt) ?? '—'}`}</p>
        <p className="text-[11px] text-muted-foreground">shipped {day(r.shippedAt) ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground">delivered {day(r.deliveredAt) ?? '—'}</p>
      </td>
      <td className="px-4 py-3 min-w-[220px]">
        {r.productSlug ? (
          <Link href={`/marketplace/${r.productSlug}`} target="_blank" className="font-semibold hover:underline">
            {r.title}
          </Link>
        ) : (
          <p className="font-semibold">{r.title}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {[r.brand, r.category?.name, r.sku ? `SKU ${r.sku}` : null].filter(Boolean).join(' · ') || '—'}
        </p>
        {r.qty > 1 && <p className="text-[11px] text-muted-foreground tabular-nums">{r.qty} × {formatPrice(r.unitNetCents, r.currency)}</p>}
      </td>
      <td className="px-4 py-3 min-w-[180px]">
        <p className="font-semibold">{r.buyer.company ?? r.buyer.name}</p>
        {r.buyer.company && <p className="text-[11px] text-muted-foreground">{r.buyer.name}</p>}
        <p className="text-[11px] text-muted-foreground font-mono">{[r.buyer.vatId, r.buyer.country].filter(Boolean).join(' · ') || '—'}</p>
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
        <p className="font-bold">{formatPrice(r.netCents, r.currency)}</p>
        {r.marginScheme && (
          <p className={`text-[11px] ${r.marginScheme.vatCents == null ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
            {r.marginScheme.vatCents == null
              ? 'margin scheme · margin VAT unknown (no purchase cost), still included'
              : `margin scheme · invoiced ${formatPrice(r.invoicedCents, r.currency)} incl. ${formatPrice(r.marginScheme.vatCents, r.currency)} margin VAT`}
          </p>
        )}
      </td>
      <td className="px-4 py-3 min-w-[160px]">
        <p className="font-semibold">{r.supplier.kind === 'own' ? `${r.supplier.name} (own stock)` : r.supplier.name}</p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {r.cost
            ? r.cost.currency
              ? `${formatPrice(r.cost.cents, r.cost.currency)} · ${r.cost.source}`
              : `${(r.cost.cents / 100).toFixed(2)} (currency not recorded) · ${r.cost.source}`
            : 'cost not recorded'}
        </p>
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
        {r.marginCents != null ? (
          <span className={r.marginCents < 0 ? 'font-bold text-red-700 dark:text-red-300' : 'font-semibold'}>{formatPrice(r.marginCents, r.currency)}</span>
        ) : (
          <span
            className="text-muted-foreground"
            title={!r.cost ? 'No supplier cost recorded' : r.marginScheme?.vatCents === null ? 'Margin VAT unknown' : 'The cost is in another currency than the sale'}
          >
            —
          </span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <Link href={`/admin/orders/${r.orderId}`} className="font-mono text-xs font-semibold hover:underline">
          {r.orderNumber}
        </Link>
        <p className="mt-1">
          <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${tone}`}>
            {STATUS_LABEL[r.status] ?? r.status.toLowerCase()}
          </span>
        </p>
        {r.poNumber && <p className="text-[11px] text-muted-foreground mt-1">PO {r.poNumber}</p>}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-xs space-y-0.5">
        {r.proformaNumber && <DocLink number={r.proformaNumber} />}
        {r.replacedInvoices.map((n) => (
          <DocLink key={n} number={n} note="replaced" />
        ))}
        {r.replacementCreditNotes.map((n) => (
          <DocLink key={n} number={n} note="cancels the replaced invoice" />
        ))}
        {r.invoice ? <DocLink number={r.invoice.number} note={day(r.invoice.issueDate) ?? undefined} /> : <p className="text-muted-foreground">no invoice yet</p>}
        {r.creditNotes.map((c) => (
          <DocLink key={c.number} number={c.number} note={`${formatPrice(c.goodsCents, r.currency)} goods · order`} />
        ))}
      </td>
    </tr>
  );
}

function DocLink({ number, note }: { number: string; note?: string }) {
  return (
    <p>
      <a href={documentNumberHref(number)} target="_blank" rel="noopener" className="font-mono font-semibold hover:underline">
        {number}
      </a>
      {note && <span className="text-muted-foreground"> · {note}</span>}
    </p>
  );
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
