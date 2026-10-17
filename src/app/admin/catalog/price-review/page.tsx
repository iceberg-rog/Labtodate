import Link from 'next/link';
import { Scale, ExternalLink } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { getImportSettings } from '@/lib/catalog/import-settings';
import { approvePendingPriceForm, rejectPendingPriceForm } from '@/app/admin/catalog-actions';
import { AdminActionForm } from '@/components/admin/AdminActionForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Price review' };

function fmtWhen(d: Date): string {
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
}

/**
 * Supplier price changes beyond the review thresholds (Settings → Import &
 * suppliers) wait here instead of going live. Approve = the new source price
 * becomes the price; Reject = keep ours and lock the price against syncs.
 */
export default async function PriceReviewPage() {
  await requireCapability('products:edit');
  const [rows, rules] = await Promise.all([
    prisma.product.findMany({
      where: { pendingPriceCents: { not: null } },
      orderBy: { pendingPriceAt: 'desc' },
      take: 500,
      select: {
        slug: true, title: true, status: true, priceCents: true, currency: true, priceOnHold: true,
        pendingPriceCents: true, pendingPriceCurrency: true, pendingPriceAt: true, pendingPriceNote: true,
        company: { select: { name: true, slug: true } },
      },
    }),
    getImportSettings(),
  ]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <Scale className="h-7 w-7 text-primary" /> Price review
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-3xl">
          A supplier price that drops by more than {rules.priceDropReviewBp / 100}% or rises by more than {rules.priceRiseReviewBp / 100}% (or changes
          currency) is not applied by a sync — it waits here.{' '}
          {rules.priceReviewHold
            ? 'Meanwhile the listing cannot be bought online and shows no price (buyers can request a quote).'
            : 'Meanwhile the listing is still sold at its current price.'}{' '}
          Thresholds and this behaviour: <Link href="/admin/settings?tab=Import%20%26%20suppliers" className="text-primary hover:underline">Settings → Import &amp; suppliers</Link>.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center text-muted-foreground" data-testid="price-review-empty">
          No price changes are waiting for review.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="price-review-list">
          {rows.map((r) => {
            const newCur = r.pendingPriceCurrency || r.currency;
            const pct =
              r.priceCents && r.pendingPriceCents !== null && newCur === r.currency
                ? Math.round(((r.pendingPriceCents - r.priceCents) / r.priceCents) * 1000) / 10
                : null;
            return (
              <li key={r.slug} className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-3" data-slug={r.slug}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <Link href={`/admin/products/${r.slug}`} className="font-semibold hover:text-primary break-words">
                      {r.title}
                    </Link>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {r.company ? (
                        <Link href={`/admin/companies/${r.company.slug}`} className="hover:underline">{r.company.name}</Link>
                      ) : (
                        'Own inventory'
                      )}{' '}
                      · {r.status.toLowerCase().replace('_', ' ')}
                      {r.pendingPriceAt ? ` · detected ${fmtWhen(r.pendingPriceAt)}` : ''}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] font-bold rounded-full px-2.5 py-1 ${
                      r.priceOnHold
                        ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300'
                        : 'bg-foreground/10 text-foreground'
                    }`}
                  >
                    {r.priceOnHold ? 'Not buyable until decided' : 'Still sold at the current price'}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-xl bg-foreground/[0.03] border border-border p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Current price</p>
                    <p className="font-bold tabular-nums mt-0.5">{r.priceCents !== null ? formatPrice(r.priceCents, r.currency) : '— (quote only)'}</p>
                  </div>
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:text-amber-300">Supplier’s new price</p>
                    <p className="font-bold tabular-nums mt-0.5">{formatPrice(r.pendingPriceCents ?? 0, newCur)}</p>
                  </div>
                  <div className="rounded-xl bg-foreground/[0.03] border border-border p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Change</p>
                    <p className={`font-bold tabular-nums mt-0.5 ${pct !== null && pct < 0 ? 'text-red-700 dark:text-red-300' : ''}`}>
                      {pct !== null ? `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toLocaleString('en-GB')} %` : newCur !== r.currency ? `currency ${r.currency} → ${newCur}` : '—'}
                    </p>
                  </div>
                </div>
                {r.pendingPriceNote && <p className="text-xs text-muted-foreground">{r.pendingPriceNote}</p>}
                <div className="flex flex-wrap items-start gap-2">
                  <AdminActionForm
                    action={approvePendingPriceForm}
                    confirmMessage={`Make ${formatPrice(r.pendingPriceCents ?? 0, newCur)} the live price of “${r.title}”?`}
                  >
                    <input type="hidden" name="slug" value={r.slug} />
                    <button type="submit" className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90">
                      Approve new price
                    </button>
                  </AdminActionForm>
                  <AdminActionForm
                    action={rejectPendingPriceForm}
                    confirmMessage={`Keep ${r.priceCents !== null ? formatPrice(r.priceCents, r.currency) : 'no price'} for “${r.title}” and lock its price against supplier syncs?`}
                  >
                    <input type="hidden" name="slug" value={r.slug} />
                    <button type="submit" className="h-9 px-4 rounded-full border border-border text-xs font-bold hover:bg-muted">
                      Reject — keep current price
                    </button>
                  </AdminActionForm>
                  <Link href={`/admin/products/${r.slug}`} className="h-9 px-4 rounded-full border border-border text-xs font-bold hover:bg-muted inline-flex items-center gap-1">
                    Set another price <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
