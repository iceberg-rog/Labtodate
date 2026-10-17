import Link from 'next/link';
import { notFound } from 'next/navigation';
import { XCircle, CheckCircle2, FileText } from 'lucide-react';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { DocumentViewer } from '@/components/documents/DocumentViewer';
import { PAID_ORDER_STATES } from '@/lib/quotes/offer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Proforma invoice' };

/**
 * The proforma invoice of a quote. It only exists once the buyer ACCEPTED the
 * offer (acceptance creates the order + proforma). Before that there is an
 * offer, not a proforma — this page says so instead of showing a document.
 * The document itself is the PDF template (download / preview), never the
 * website page printed.
 */
export default async function ProformaPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/quotes/${params.id}/proforma` });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    select: { id: true, submittedById: true, buyerEmail: true, status: true, proformaNumber: true },
  });
  if (!sr) notFound();

  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  const isBuyer = sr.submittedById === session.user.id || sr.buyerEmail === session.user.email;
  // Buyer documents carry the buyer's identity: buyer and admins only.
  if (!isBuyer && !staffView) notFound();
  const threadHref = staffView && !isBuyer ? `/admin/quotes/${sr.id}` : `/app/quotes/${sr.id}`;

  const order = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { orderNumber: true, status: true, buyerId: true },
  });

  if (!order || !sr.proformaNumber) {
    return (
      <div className="container-px py-16 max-w-xl mx-auto text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center mb-4">
          <FileText className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">No proforma invoice yet</h1>
        <p className="text-muted-foreground mt-3">
          A proforma invoice is issued when the offer is accepted. Until then you can review the offer
          — and accept or decline it — on the quote page.
        </p>
        <Link href={threadHref} className="mt-6 inline-flex items-center rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold">
          Open the quote
        </Link>
      </div>
    );
  }

  const isVoid = order.status === 'CANCELED';
  const isPaid = PAID_ORDER_STATES.includes(order.status);
  return (
    <DocumentViewer
      kind="proforma"
      orderNumber={order.orderNumber}
      title="Proforma invoice"
      number={sr.proformaNumber}
      backHref={threadHref}
      backLabel="Back to the quote"
    >
      {isVoid && (
        <div className="rounded-2xl border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 p-4 mb-4 flex items-start gap-3 text-sm">
          <XCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
          <p><strong>Void — this proforma can no longer be paid.</strong> Order <span className="font-mono">{order.orderNumber}</span> was canceled. Please do not send a transfer for it.</p>
        </div>
      )}
      {isPaid && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 p-3 mb-4 inline-flex items-start gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
          <p>
            <strong>Paid</strong> — order <span className="font-mono">{order.orderNumber}</span>. Your invoice is on the{' '}
            <Link className="underline font-semibold" href={`/app/orders/${order.orderNumber}/invoice`}>invoice page</Link>.
          </p>
        </div>
      )}
    </DocumentViewer>
  );
}
