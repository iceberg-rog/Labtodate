import { notFound } from 'next/navigation';
import { Clock } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { DocumentViewer } from '@/components/documents/DocumentViewer';
import { getOrderDocuments } from '@/lib/documents/issue';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Invoice' };

/**
 * The buyer's invoice for an order (once issued), or its proforma invoice
 * while it is still unpaid — the stored, issued document (PDF download /
 * preview), never a printed website page.
 */
export default async function InvoicePage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await params;
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}/invoice` });

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, orderNumber: true, buyerId: true, status: true },
  });
  if (!order || order.buyerId !== session.user.id) notFound();
  const docs = await getOrderDocuments(order.id);

  if (docs.invoice) {
    return (
      <DocumentViewer
        kind="invoice"
        orderNumber={order.orderNumber}
        title="Invoice"
        number={docs.invoice.number}
        backHref={`/app/orders/${order.orderNumber}`}
        backLabel={`Back to order ${order.orderNumber}`}
      />
    );
  }

  const paid = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(order.status);
  return (
    <DocumentViewer
      kind="proforma"
      orderNumber={order.orderNumber}
      title="Proforma invoice"
      number={docs.proforma?.number ?? order.orderNumber}
      backHref={`/app/orders/${order.orderNumber}`}
      backLabel={`Back to order ${order.orderNumber}`}
    >
      {order.status !== 'CANCELED' && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 p-3 mb-4 text-sm inline-flex items-start gap-2">
          <Clock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {paid
              ? <><strong>Payment received.</strong> Your invoice is being prepared — you will receive it by email.</>
              : <><strong>Not paid yet.</strong> This is your proforma invoice. The final invoice is issued once your payment has been verified.</>}
          </span>
        </p>
      )}
    </DocumentViewer>
  );
}
