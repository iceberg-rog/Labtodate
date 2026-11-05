import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileText } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { formatPrice } from '@/lib/utils';
import { ensureLegacyQuoteDoc, PAID_ORDER_STATES, snapshotOf } from '@/lib/documents/issue';
import { DocumentViewer } from '@/components/documents/DocumentViewer';
import { ResendDocumentsButton } from '@/components/admin/documents/ResendDocumentsButton';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ id: string }> }) {
  return adminDetailTitle('orders:view', 'Documents', async () => {
    const { id } = await props.params;
    const o = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } });
    return o && `Documents ${o.orderNumber}`;
  });
}

const KIND_LABEL: Record<string, string> = { QUOTE: 'Quote', INVOICE: 'Invoice', RECEIPT: 'Receipt' };

/**
 * Every document issued for an order (quote revisions, invoice, receipt),
 * exactly as the buyer received them, with PDF download and print. Replaces
 * the old hand-built admin invoice page.
 */
export default async function OrderDocumentsPage(props: { params: Promise<{ id: string }>; searchParams?: Promise<{ doc?: string }> }) {
  const { id } = await props.params;
  const sp = (await props.searchParams) ?? {};
  await requireCapability('orders:view');
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, orderNumber: true, status: true, sourcingRequestId: true },
  });
  if (!order) notFound();
  if (order.sourcingRequestId) await ensureLegacyQuoteDoc(order.sourcingRequestId).catch(() => null);
  const docs = await prisma.issuedDocument.findMany({
    where: { OR: [{ orderId: order.id }, ...(order.sourcingRequestId ? [{ sourcingRequestId: order.sourcingRequestId }] : [])] },
    orderBy: [{ issuedAt: 'desc' }, { revision: 'desc' }],
    select: { id: true, kind: true, number: true, revision: true, issuedAt: true, totalCents: true, currency: true, supersededAt: true, voidedAt: true, lang: true, snapshot: true },
  });
  const selected = docs.find((d) => d.id === sp.doc) ?? docs.find((d) => d.kind === 'INVOICE') ?? docs[0];
  const paid = PAID_ORDER_STATES.includes(order.status);

  return (
    <div className="container-px py-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href={`/admin/orders/${order.id}`} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5">
          <ChevronLeft className="h-3.5 w-3.5" /> Back to order {order.orderNumber}
        </Link>
        <div className="flex items-center gap-3">
          {paid && <ResendDocumentsButton orderId={order.id} />}
          <Link href="/admin/documents?tab=templates" className="text-xs font-semibold text-primary hover:underline">Edit templates →</Link>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-border bg-card p-3 self-start">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-2 mb-2">Issued documents</h2>
          {docs.length === 0 && (
            <p className="text-sm text-muted-foreground px-2">Nothing issued yet.{paid ? '' : ' The invoice is issued when the payment is verified.'}</p>
          )}
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d.id}>
                <Link href={`?doc=${d.id}`} className={`block rounded-lg px-2 py-2 text-sm ${selected?.id === d.id ? 'bg-primary/10 text-primary' : 'hover:bg-foreground/[0.04]'}`}>
                  <span className="font-semibold inline-flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" /> {KIND_LABEL[d.kind] ?? d.kind} {d.number}{d.revision > 1 ? ` rev ${d.revision}` : ''}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {d.issuedAt.toISOString().slice(0, 10)} · {formatPrice(d.totalCents, d.currency)} · {d.lang.toUpperCase()}
                    {d.supersededAt ? ' · replaced' : ''}
                    {d.voidedAt ? ' · void' : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
        <div className="min-w-0">
          {selected ? (
            <DocumentViewer
              key={selected.id}
              htmlUrl={`/api/documents/${selected.id}?format=html`}
              pdfUrl={`/api/documents/${selected.id}`}
              title={`${snapshotOf(selected).texts.title} ${selected.number}`}
            />
          ) : (
            <p className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">No document to show yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
