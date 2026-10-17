import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { DocumentViewer } from '@/components/documents/DocumentViewer';
import { getOrderDocuments } from '@/lib/documents/issue';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ id: string }> }) {
  return adminDetailTitle('orders:view', 'Invoice', async () => {
    const { id } = await props.params;
    const o = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } });
    return o && `Invoice ${o.orderNumber}`;
  });
}

/**
 * Admin view of an order's issued document: the invoice once issued,
 * otherwise the current proforma. Same stored document the buyer gets — the
 * admin sidebar never ends up in a document.
 */
export default async function AdminInvoicePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('orders:view');

  const order = await prisma.order.findUnique({
    where: { id: params.id },
    select: { id: true, orderNumber: true, status: true, holdNote: true },
  });
  if (!order) notFound();
  const docs = await getOrderDocuments(order.id);
  const inv = docs.invoice;
  return (
    <DocumentViewer
      kind={inv ? 'invoice' : 'proforma'}
      orderNumber={order.orderNumber}
      title={inv ? 'Invoice' : 'Proforma invoice'}
      number={inv?.number ?? docs.proforma?.number ?? order.orderNumber}
      backHref={`/admin/orders/${order.id}`}
      backLabel={`Back to order ${order.orderNumber}`}
    >
      {!inv && ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(order.status) && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 p-3 mb-4 text-sm">
          <strong>No invoice issued for this paid order.</strong> {order.holdNote ?? 'Issue it from the order page.'}
        </p>
      )}
    </DocumentViewer>
  );
}
