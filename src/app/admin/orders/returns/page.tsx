import Link from 'next/link';
import { ChevronLeft, RotateCcw, CircleDollarSign } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { smartDate } from '@/lib/orders/display';
import { OPEN_RETURN_STATUSES, REFUND_STATUS_LABEL, RETURN_STATUS_LABEL, RETURN_TYPE_LABEL } from '@/lib/fulfilment/rules';
import { METHOD_LABEL, type RefundMethod } from '@/lib/finance/refunds';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Returns & refunds' };

const NEXT: Record<string, string> = {
  REQUESTED: 'Review: approve or reject',
  APPROVED: 'Waiting for the goods (or settle if nothing comes back)',
  LABEL_SENT: 'Waiting for the goods',
  IN_TRANSIT: 'On its way back — record the receipt',
  RECEIVED: 'Inspect (grade + restock decision)',
  INSPECTED: 'Resolve (refund / credit, repair, replacement)',
};

/** Admin queue: open returns (RMA) and refunds that still need a bank transfer. */
export default async function AdminReturnsQueuePage() {
  await requireCapability('orders:view');
  const [openReturns, toSend, toConfirm, closed] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { status: { in: [...OPEN_RETURN_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, rmaNumber: true, type: true, status: true, reasonCode: true, createdAt: true, noReturnNeeded: true, order: { select: { id: true, orderNumber: true, buyer: { select: { name: true } } } } },
    }),
    prisma.refund.findMany({ where: { status: 'REQUESTED' }, orderBy: { createdAt: 'asc' }, select: { id: true, amountCents: true, currency: true, method: true, reason: true, createdAt: true, order: { select: { id: true, orderNumber: true, buyer: { select: { name: true } } } } } }),
    prisma.refund.findMany({ where: { status: 'SENT' }, orderBy: { executedAt: 'asc' }, select: { id: true, amountCents: true, currency: true, method: true, executedAt: true, bankRef: true, order: { select: { id: true, orderNumber: true } } } }),
    prisma.returnRequest.findMany({ where: { status: { in: ['RESOLVED', 'DENIED'] } }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, rmaNumber: true, type: true, status: true, outcome: true, updatedAt: true, order: { select: { id: true, orderNumber: true } } } }),
  ]);
  const card = 'rounded-2xl border border-border bg-card overflow-hidden';
  const head = 'px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2';
  return (
    <div className="space-y-6 max-w-5xl">
      <Link href="/admin/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" /> Orders</Link>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Returns &amp; refunds</h1>
        <p className="text-muted-foreground mt-1 text-sm">{openReturns.length} open return{openReturns.length === 1 ? '' : 's'} · {toSend.length} refund{toSend.length === 1 ? '' : 's'} waiting for a bank transfer · {toConfirm.length} sent, to confirm</p>
      </div>

      <section className={card} data-testid="refunds-to-send">
        <div className={head}><CircleDollarSign className="h-4 w-4 text-primary" /><h2 className="text-sm font-bold">Refunds to send ({toSend.length})</h2></div>
        {toSend.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Nothing to send.</p> : (
          <ul className="divide-y divide-border">
            {toSend.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/orders/${r.order.id}#money`} className="flex items-center gap-3 px-5 py-3 hover:bg-foreground/[0.03] flex-wrap">
                  <span className="font-mono text-xs">{r.order.orderNumber}</span>
                  <span className="text-sm font-bold tabular-nums">{formatPrice(r.amountCents, r.currency)}</span>
                  <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{r.order.buyer.name} · {METHOD_LABEL[r.method as RefundMethod] ?? r.method} · {r.reason}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">{REFUND_STATUS_LABEL.REQUESTED} · {smartDate(r.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} data-testid="open-returns">
        <div className={head}><RotateCcw className="h-4 w-4 text-primary" /><h2 className="text-sm font-bold">Open returns &amp; complaints ({openReturns.length})</h2></div>
        {openReturns.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No open returns.</p> : (
          <ul className="divide-y divide-border">
            {openReturns.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/orders/${r.order.id}#returns`} className="block px-5 py-3 hover:bg-foreground/[0.03]">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs font-semibold">{r.rmaNumber}</span>
                    <span className="text-xs">{RETURN_TYPE_LABEL[r.type] ?? r.type}</span>
                    <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{r.reasonCode} · {r.order.buyer.name} · order {r.order.orderNumber}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">{RETURN_STATUS_LABEL[r.status]} · {smartDate(r.createdAt)}</span>
                  </div>
                  <p className="text-xs text-primary font-semibold mt-1">Next: {r.noReturnNeeded && (r.status === 'APPROVED' || r.status === 'LABEL_SENT') ? 'Resolve (nothing comes back)' : NEXT[r.status] ?? '—'}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {toConfirm.length > 0 && (
        <section className={card}>
          <div className={head}><CircleDollarSign className="h-4 w-4 text-primary" /><h2 className="text-sm font-bold">Sent — confirm against the bank statement ({toConfirm.length})</h2></div>
          <ul className="divide-y divide-border">
            {toConfirm.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/orders/${r.order.id}#money`} className="flex items-center gap-3 px-5 py-3 hover:bg-foreground/[0.03] flex-wrap text-sm">
                  <span className="font-mono text-xs">{r.order.orderNumber}</span>
                  <span className="font-bold tabular-nums">{formatPrice(r.amountCents, r.currency)}</span>
                  <span className="text-xs text-muted-foreground flex-1">{METHOD_LABEL[r.method as RefundMethod] ?? r.method}{r.executedAt ? ` · sent ${smartDate(r.executedAt)}` : ''}{r.bankRef ? ` · ref ${r.bankRef}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 && (
        <section className={card}>
          <div className={head}><RotateCcw className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-bold">Recently closed</h2></div>
          <ul className="divide-y divide-border">
            {closed.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/orders/${r.order.id}#returns`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-foreground/[0.03] flex-wrap text-xs">
                  <span className="font-mono font-semibold">{r.rmaNumber}</span>
                  <span>{RETURN_TYPE_LABEL[r.type] ?? r.type}</span>
                  <span className="text-muted-foreground flex-1">{r.status === 'DENIED' ? 'not approved' : (r.outcome ?? '').replace(/_/g, ' ').toLowerCase()} · {smartDate(r.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
