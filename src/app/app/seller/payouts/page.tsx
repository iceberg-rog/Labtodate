import { Banknote } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { ensureSettingsLoaded } from '@/lib/settings';
import { OrderStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';
const PAID: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export default async function SellerPayoutsPage() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/payouts' });
  await ensureSettingsLoaded();
  const pct = Math.max(0, Math.min(100, parseFloat(process.env.SELLER_COMMISSION_PCT || '8') || 0));

  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { companyId: true } });
  const items = me?.companyId
    ? await prisma.orderItem.findMany({
        where: { product: { companyId: me.companyId }, order: { status: { in: PAID } } },
        include: { order: { select: { orderNumber: true, currency: true, status: true, createdAt: true } } },
      })
    : [];

  const currency = items[0]?.order.currency || 'EUR';
  const gross = items.reduce((s, i) => s + i.priceCentsSnapshot * i.quantity, 0);
  const commission = Math.round((gross * pct) / 100);
  const net = gross - commission;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payouts &amp; statement</h1>
        <p className="text-muted-foreground mt-1">Your sales on lab2date · {pct}% commission</p>
      </div>

      {!me?.companyId ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Banknote className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No seller company linked</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-2xl font-bold data">{formatPrice(gross, currency)}</p>
              <p className="text-xs text-muted-foreground mt-1">Gross sales</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-2xl font-bold data text-red-700">−{formatPrice(commission, currency)}</p>
              <p className="text-xs text-muted-foreground mt-1">Commission ({pct}%)</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-2xl font-bold data text-emerald-700">{formatPrice(net, currency)}</p>
              <p className="text-xs text-muted-foreground mt-1">Net payout</p>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 font-bold">Order</th>
                    <th className="px-5 py-3 font-bold">Item</th>
                    <th className="px-5 py-3 font-bold">Qty</th>
                    <th className="px-5 py-3 font-bold">Gross</th>
                    <th className="px-5 py-3 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((i) => (
                    <tr key={i.id} className="hover:bg-foreground/[0.02]">
                      <td className="px-5 py-3 font-mono text-xs">{i.order.orderNumber}</td>
                      <td className="px-5 py-3">{i.titleSnapshot}</td>
                      <td className="px-5 py-3 tabular-nums">{i.quantity}</td>
                      <td className="px-5 py-3 font-bold data">{formatPrice(i.priceCentsSnapshot * i.quantity, currency)}</td>
                      <td className="px-5 py-3 text-muted-foreground">{i.order.status.toLowerCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
