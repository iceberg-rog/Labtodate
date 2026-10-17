import { prisma } from '@/lib/db';

/**
 * Retention rules for hard deletes (A05). Financial records — anything that
 * was paid, invoiced, refunded, shipped, or had a document issued — are kept
 * (archive instead). The DB enforces the same with triggers and RESTRICT FKs;
 * these helpers produce the readable reason for the admin UI.
 */

const PAID = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'];

export async function orderDeletionBlockers(orderId: string): Promise<string[]> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      paidAt: true,
      amountPaidCents: true,
      sourcingRequest: { select: { status: true } },
      documents: { select: { number: true }, take: 5 },
      _count: { select: { payments: true, refunds: true, shipments: true, returnRequests: true, documents: true } },
    },
  });
  if (!o) return [];
  const why: string[] = [];
  if (PAID.includes(o.status) || o.paidAt || o.amountPaidCents > 0 || o._count.payments > 0) why.push('it was paid');
  if (o._count.documents > 0) {
    why.push(`documents were issued for it (${o.documents.map((d) => d.number).join(', ')}${o._count.documents > 5 ? ', …' : ''})`);
  }
  if (o._count.refunds > 0) why.push('it has a refund');
  if (o._count.shipments > 0) why.push('it was shipped');
  if (o._count.returnRequests > 0) why.push('it has a return');
  if (o.sourcingRequest?.status === 'ACCEPTED') why.push('it belongs to an accepted quote');
  return why;
}

export async function quoteDeletionBlockers(quoteId: string): Promise<string[]> {
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: quoteId },
    select: {
      status: true,
      proformaNumber: true,
      quotedPriceCents: true,
      order: { select: { orderNumber: true } },
      _count: { select: { messages: { where: { fromStaff: true, isInternalNote: false } } } },
    },
  });
  if (!sr) return [];
  const why: string[] = [];
  if (sr.status === 'ACCEPTED') why.push('the buyer accepted an offer');
  if (sr.proformaNumber) why.push(`proforma ${sr.proformaNumber} was issued`);
  if (sr.order) why.push(`order ${sr.order.orderNumber} was created from it`);
  if (sr.quotedPriceCents != null) why.push('an offer was sent to the buyer');
  if (sr._count.messages > 0) why.push('staff replied to the buyer');
  return why;
}
