import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { canOpenDocument, notFound, serveIssued, serveSnapshot } from '@/lib/documents/http';
import { currentOrderDoc, ensureInvoice, ensureLegacyQuoteDoc, PAID_ORDER_STATES, paymentRequestSnapshot } from '@/lib/documents/issue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The document that belongs to an order right now:
 *  - paid → its invoice (issued on first request if the payment flow could not)
 *  - unpaid, from a quote → the quote
 *  - unpaid cart order → a payment request from the invoice template (not
 *    stored, carries the order number, never an invoice number)
 */
export async function GET(req: NextRequest, props: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await props.params;
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, status: true, sourcingRequestId: true },
  });
  if (!order || !(await canOpenDocument({ orderId: order.id, sourcingRequestId: order.sourcingRequestId, kind: 'INVOICE' }))) return notFound();
  const sp = req.nextUrl.searchParams;
  const format = sp.get('format');
  const download = sp.get('download') === '1';
  const kind = sp.get('kind');
  if (kind === 'receipt') {
    const receipt = await currentOrderDoc(order.id, 'RECEIPT');
    return receipt ? serveIssued(receipt, format, download) : notFound();
  }
  if (PAID_ORDER_STATES.includes(order.status)) {
    const invoice = await ensureInvoice(order.id).catch(() => null);
    if (invoice) return serveIssued(invoice, format, download);
    return new NextResponse('The invoice could not be issued right now. Please try again shortly.', { status: 503 });
  }
  if (order.sourcingRequestId) {
    const quote = await ensureLegacyQuoteDoc(order.sourcingRequestId);
    if (quote) return serveIssued(quote, format, download);
  }
  const snap = await paymentRequestSnapshot(order.id);
  return snap ? serveSnapshot(snap, format, download) : notFound();
}
