import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { siteName } from '@/lib/brand/identity';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sellerSeesSellPrice } from '@/lib/quotes/policy';
import { sellerProgramme } from '@/lib/sellers/programme';
import { formatMoney, loadSupplierSales, saleStage, totalsByCurrency, type SupplierSaleLine } from '@/lib/sellers/supplier-sales';
import { ProgrammeText } from '@/components/seller/ProgrammeText';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payouts & statement' };

/**
 * What we owe the supplier for its sold units (D15): its agreed supplier price
 * — the price recorded with the accepted offer for a quote deal, the listing
 * price before our margin for a checkout sale — in its own currency. Our sell
 * price is shown only while Settings → Quotes & offers → “Suppliers see the
 * buyer price” is on. No commission or “net payout” is computed: how and when
 * suppliers are paid is the owner's text (Settings → Suppliers).
 */
export default async function SellerPayoutsPage() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/payouts' });
  await ensureSettingsLoaded();
  const [lines, me] = await Promise.all([
    loadSupplierSales(session.user.id),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, companyId: true } }),
  ]);
  const showSellPrice = sellerSeesSellPrice();
  const programme = sellerProgramme();
  const totals = totalsByCurrency(lines);
  const unpriced = lines.filter((l) => l.supplierCents == null).length;
  const units = lines.reduce((n, l) => n + l.quantity, 0);
  const toDispatch = lines.filter((l) => saleStage(l) === 'paid').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payouts &amp; statement</h1>
        <p className="text-muted-foreground mt-1">
          Units you supplied that were sold through {siteName()}, at your agreed price (excl. VAT).
        </p>
      </div>

      {me?.role === 'SELLER' && !me.companyId && (
        <p className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm">
          Your account is not linked to your company yet. Our team links it before your listings go live.
        </p>
      )}
      {me?.role === 'ADMIN' && (
        <p className="rounded-xl border border-border bg-foreground/[0.03] px-4 py-3 text-sm text-muted-foreground">
          This statement is for suppliers. Listings of staff accounts are our own stock and do not appear here.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card value={String(units)} label={units === 1 ? 'Unit sold' : 'Units sold'} />
        <Card
          value={totals.length ? totals.map((t) => formatMoney(t.cents, t.currency)).join(' + ') : '—'}
          label={`Your price for these units, excl. VAT${unpriced ? ` · ${unpriced} without a recorded price` : ''}`}
        />
        <Card value={String(toDispatch)} label="Paid, not shipped yet" />
      </div>

      {lines.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Banknote className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No sales yet</p>
          <p className="text-sm text-muted-foreground mt-2">Units appear here once the buyer has paid.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 font-bold">Order</th>
                  <th className="px-5 py-3 font-bold">Item</th>
                  <th className="px-5 py-3 font-bold">Qty</th>
                  <th className="px-5 py-3 font-bold">Your price</th>
                  {showSellPrice && <th className="px-5 py-3 font-bold">Sold for</th>}
                  <th className="px-5 py-3 font-bold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((l) => (
                  <tr key={l.key} className="hover:bg-foreground/[0.02]">
                    <td className="px-5 py-3 font-mono text-xs whitespace-nowrap">{l.orderNumber}</td>
                    <td className="px-5 py-3" dir="auto">
                      {l.quoteId ? <Link href={`/app/seller/inbox/${l.quoteId}`} className="hover:text-primary">{l.title}</Link> : l.title}
                    </td>
                    <td className="px-5 py-3 tabular-nums">{l.quantity}</td>
                    <td className="px-5 py-3 font-bold data whitespace-nowrap">
                      {l.supplierCents != null ? formatMoney(l.supplierCents, l.supplierCurrency) : <span className="font-normal text-muted-foreground">not recorded</span>}
                    </td>
                    {showSellPrice && <td className="px-5 py-3 data whitespace-nowrap">{formatMoney(l.soldForCents, l.soldForCurrency)}</td>}
                    <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">{stageText(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {unpriced > 0 && (
        <p className="text-xs text-muted-foreground">
          “Not recorded”: no supplier price was saved with this deal. Ask our team which price applies.
        </p>
      )}

      <div className="rounded-2xl border border-border bg-card p-5 text-sm">
        <p className="text-sm font-bold mb-1">How you are paid</p>
        <ProgrammeText blocks={programme.payout} contactHref={programme.contactHref} contactLabel={programme.contactLabel} compact />
      </div>
    </div>
  );
}

const day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function stageText(l: SupplierSaleLine): string {
  const stage = saleStage(l);
  if (stage === 'delivered' && l.deliveredAt) return `delivered ${day(l.deliveredAt)}`;
  if (stage === 'shipped' && l.shippedAt) return `shipped ${day(l.shippedAt)}`;
  return l.paidAt ? `paid ${day(l.paidAt)} · to dispatch` : 'paid · to dispatch';
}

function Card({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-2xl font-bold data">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}
