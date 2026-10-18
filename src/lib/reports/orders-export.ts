import type { Prisma } from '@prisma/client';
import { humaniseBuyer } from '@/lib/orders/display';
import { csvMoney, csvRate } from './csv';
import { normaliseVatId } from './documents';
import { localDay } from './period';
import { invoicesOf } from './revenue';

/**
 * The orders CSV (Admin → Orders → Export) for book-keeping: the order, its
 * money and fulfilment, and the fiscal columns the accountant books from. The
 * invoice and VAT columns come from the order's CURRENT invoice as issued
 * (after a correction: the replacing invoice); before an invoice exists they
 * come from the order itself.
 */

export const ORDER_EXPORT_INCLUDE = {
  buyer: { select: { name: true, email: true } },
  items: { select: { titleSnapshot: true, quantity: true, priceCentsSnapshot: true } },
  sourcingRequest: { select: { proformaNumber: true } },
  documents: {
    select: { kind: true, number: true, issueDate: true, createdAt: true, vatTreatment: true, taxCents: true, totalCents: true, voidedAt: true, snapshot: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.OrderInclude;

export type OrderExportRecord = Prisma.OrderGetPayload<{ include: typeof ORDER_EXPORT_INCLUDE }>;

export const ORDER_CSV_HEADER = [
  'order_number',
  'created_at_iso',
  'status',
  'buyer',
  'buyer_email',
  'items',
  'subtotal',
  'shipping',
  'tax',
  'total',
  'currency',
  'carrier',
  'tracking_number',
  'shipped_at_iso',
  'delivered_at_iso',
  'paid_at_iso',
  'stripe_payment_intent',
  'po_number',
  'proforma_number',
  'invoice_number',
  'invoice_date',
  'vat_treatment',
  'vat_rate',
  'vat_amount',
  'buyer_vat_id',
  'credit_note_numbers',
  'credit_notes_total',
] as const;

/** VAT rates and buyer VAT ID as printed on an issued document. */
export function printedVat(snapshot: unknown): { rates: number[]; buyerVatId: string | null } {
  const s = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as {
    vat?: { rows?: Array<{ rateBp?: unknown }>; buyerVatId?: unknown };
    buyer?: { vatId?: unknown };
  };
  const rates = Array.isArray(s.vat?.rows) ? s.vat.rows.map((r) => r?.rateBp).filter((r): r is number => Number.isInteger(r)) : [];
  const id = typeof s.vat?.buyerVatId === 'string' ? s.vat.buyerVatId : typeof s.buyer?.vatId === 'string' ? s.buyer.vatId : null;
  return { rates: [...new Set(rates)], buyerVatId: normaliseVatId(id) };
}

/** One CSV row in ORDER_CSV_HEADER order (invoice date: YYYY-MM-DD in the business time zone). */
export function orderCsvRow(o: OrderExportRecord, tz: string): string[] {
  const b = humaniseBuyer(o.buyer);
  const items = o.items.map((i) => `${i.quantity}× ${i.titleSnapshot} (${(i.priceCentsSnapshot / 100).toFixed(2)})`).join(' | ');
  const invoices = invoicesOf(o.documents);
  const invoice = invoices[invoices.length - 1] ?? null;
  const credits = o.documents.filter((d) => d.kind === 'CREDIT_NOTE');
  const proforma = [...o.documents].reverse().find((d) => d.kind === 'PROFORMA' && !d.voidedAt);
  const printed = invoice ? printedVat(invoice.snapshot) : null;
  // Not invoiced yet: the goods rate, and the freight rate when it differs.
  const rates = printed?.rates.length
    ? printed.rates
    : [...new Set([o.vatRateBp, o.shippingCents > 0 ? o.shippingVatRateBp : null].filter((r): r is number => r != null))];
  return [
    o.orderNumber,
    o.createdAt.toISOString(),
    o.status,
    b.primary,
    b.anonymised ? '' : (o.buyer.email ?? ''),
    items,
    csvMoney(o.subtotalCents),
    csvMoney(o.shippingCents),
    csvMoney(o.taxCents),
    csvMoney(o.totalCents),
    o.currency,
    o.trackingCarrier ?? '',
    o.trackingNumber ?? '',
    o.shippedAt?.toISOString() ?? '',
    o.deliveredAt?.toISOString() ?? '',
    o.paidAt?.toISOString() ?? '',
    o.stripePaymentIntentId ?? '',
    o.poNumber ?? '',
    o.proformaNumber ?? proforma?.number ?? o.sourcingRequest?.proformaNumber ?? '',
    invoice?.number ?? '',
    invoice ? localDay(invoice.issueDate, tz) : '',
    invoice?.vatTreatment ?? o.vatTreatment ?? '',
    rates.map(csvRate).join('|'),
    csvMoney(invoice ? invoice.taxCents : o.taxCents),
    printed?.buyerVatId ?? normaliseVatId(o.buyerVatId) ?? '',
    credits.map((d) => d.number).join(' | '),
    credits.length ? csvMoney(credits.reduce((s, d) => s + d.totalCents, 0)) : '',
  ];
}
