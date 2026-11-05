import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { currentOrderDoc, ensureInvoice, PAID_ORDER_STATES, snapshotOf } from '@/lib/documents/issue';
import { DocumentViewer } from '@/components/documents/DocumentViewer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Invoice' };

/**
 * The buyer's invoice for an order. A paid order shows its issued (frozen)
 * invoice and receipt; an unpaid one shows the payment request — the quote
 * for quote orders — which is never presented as a final invoice.
 */
export default async function InvoicePage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await params;
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}/invoice` });
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, buyerId: true, status: true, orderNumber: true },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  const paid = PAID_ORDER_STATES.includes(order.status);
  const invoice = paid ? await ensureInvoice(order.id).catch(() => null) : null;
  const receipt = paid ? await currentOrderDoc(order.id, 'RECEIPT') : null;
  const base = `/api/documents/order/${encodeURIComponent(order.orderNumber)}`;
  const title = invoice ? `${snapshotOf(invoice).texts.title} ${invoice.number}` : `Payment request ${order.orderNumber}`;

  return (
    <div className="container-px py-10 max-w-4xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">{invoice ? snapshotOf(invoice).texts.title : 'Not paid yet'}</p>
          <h1 className="text-2xl font-bold font-mono mt-0.5">{invoice ? invoice.number : order.orderNumber}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Order <Link className="underline" href={`/app/orders/${order.orderNumber}`}>{order.orderNumber}</Link>
            {receipt && <> · <a className="underline" href={`${base}?kind=receipt&download=1`}>Download the receipt ({receipt.number})</a></>}
          </p>
        </div>
      </div>
      {!paid && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 p-3 text-sm">
          This order is not paid yet. Below is the payment request; your invoice is issued as soon as the payment is verified.
        </p>
      )}
      {paid && !invoice ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 text-red-900 p-3 text-sm">The invoice could not be made right now. Please refresh in a minute.</p>
      ) : (
        <DocumentViewer htmlUrl={`${base}?format=html`} pdfUrl={base} title={title} />
      )}
    </div>
  );
}
