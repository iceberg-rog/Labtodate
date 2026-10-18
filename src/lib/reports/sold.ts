import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { humaniseBuyer } from '@/lib/orders/display';
import { ensureSettingsLoaded } from '@/lib/settings';
import { docNetSplit, invoiceChain, saleDateOf, SOLD_ORDER_STATUSES } from './revenue';
import { MARGIN_ITEM_SELECT, marginVatByDocument, marginVatRateBp, orderMarginOf } from './margin-vat';
import { inPeriod, localDay, prefilterBounds, type Period } from './period';
import { csvMoney } from './csv';

/**
 * The Sold register: one row per sold order line (goods), from the moment the
 * order is paid (or invoiced on terms) through delivery — the owner's sales
 * history and the accountant's sales list. Prices are excl. VAT: a
 * margin-scheme line has the margin VAT inside its invoiced price, which is
 * taken off (computed as on the invoice; unknown without a purchase cost).
 * Supplier cost and margin are internal (finance:view) and shown only when
 * they were recorded; a margin is computed only when cost and sale are in the
 * same currency (no exchange rate is stored).
 */

export const SOLD_STATUS_VIEWS = {
  sold: { label: 'Sold', statuses: [...SOLD_ORDER_STATUSES] },
  awaiting: { label: 'Awaiting dispatch', statuses: ['PAID', 'PROCESSING'] },
  shipped: { label: 'Shipped', statuses: ['SHIPPED'] },
  delivered: { label: 'Delivered', statuses: ['DELIVERED'] },
  refunded: { label: 'Refunded', statuses: ['REFUNDED'] },
  all: { label: 'All incl. refunded', statuses: [...SOLD_ORDER_STATUSES, 'REFUNDED'] },
} as const satisfies Record<string, { label: string; statuses: readonly string[] }>;
export type SoldStatusView = keyof typeof SOLD_STATUS_VIEWS;

export function soldStatusView(v: string | null | undefined): SoldStatusView {
  return v && v in SOLD_STATUS_VIEWS ? (v as SoldStatusView) : 'sold';
}

export interface SupplierRef {
  /** Filter key: shop:<slug> · seller:<userId> · own */
  key: string;
  name: string;
  kind: 'shop' | 'seller' | 'own';
}

export interface SoldCost {
  cents: number;
  /** null = the currency was not recorded (older quotes). */
  currency: string | null;
  source: 'quote' | 'supplier price' | 'purchase cost';
}

interface PartyIn {
  id: string;
  name: string;
  role: string;
  company: { name: string; slug: string } | null;
}

/**
 * Who supplied the unit: the shop that lists it, else the supplier (seller
 * account) that quoted it or owns the listing, else own stock.
 */
export function supplierOf(
  p: { company: { name: string; slug: string } | null; seller: PartyIn | null } | null,
  quoteAssignee: PartyIn | null,
  ownName: string,
): SupplierRef {
  if (p?.company) return { key: `shop:${p.company.slug}`, name: p.company.name, kind: 'shop' };
  const seller = quoteAssignee?.role === 'SELLER' ? quoteAssignee : p?.seller?.role === 'SELLER' ? p.seller : null;
  if (seller?.company) return { key: `shop:${seller.company.slug}`, name: seller.company.name, kind: 'shop' };
  if (seller) return { key: `seller:${seller.id}`, name: seller.name, kind: 'seller' };
  return { key: 'own', name: ownName, kind: 'own' };
}

/**
 * What the unit cost: the supplier cost behind the accepted offer (quotes),
 * else the supplier's price before the shop markup (Buy now from a supplier),
 * else the recorded purchase cost of own stock. null = not recorded.
 */
export function costOf(p: {
  qty: number;
  orderCurrency: string;
  basePriceCents: number | null;
  supplierKind: SupplierRef['kind'];
  quote: { offerSupplierCostCents: number | null; offerSupplierCostCurrency: string | null; sellerProposalCurrency: string | null } | null;
  /** The quote's cost belongs to the quoted line (a quote order has one goods line). */
  quotedLine: boolean;
  product: { purchaseCostCents: number | null; currency: string } | null;
}): SoldCost | null {
  if (p.quote?.offerSupplierCostCents != null && p.quotedLine) {
    return {
      cents: p.quote.offerSupplierCostCents,
      currency: p.quote.offerSupplierCostCurrency ?? p.quote.sellerProposalCurrency ?? null,
      source: 'quote',
    };
  }
  if (p.supplierKind !== 'own' && p.basePriceCents != null) {
    return { cents: p.basePriceCents * p.qty, currency: p.orderCurrency, source: 'supplier price' };
  }
  if (p.product?.purchaseCostCents != null) {
    return { cents: p.product.purchaseCostCents * p.qty, currency: p.product.currency, source: 'purchase cost' };
  }
  return null;
}

/** Sale minus cost, only when both are in the same currency. */
export function marginOf(netCents: number, currency: string, cost: SoldCost | null): number | null {
  return cost && cost.currency === currency ? netCents - cost.cents : null;
}

export interface SoldRow {
  itemId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  financialStatus: string;
  /** Sold on invoice terms, not paid yet. */
  onTerms: boolean;
  saleAt: Date | null;
  paidAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  productId: string | null;
  productSlug: string | null;
  title: string;
  brand: string | null;
  sku: string | null;
  category: { name: string; slug: string } | null;
  qty: number;
  unitNetCents: number;
  netCents: number;
  /** The line as invoiced (differs from netCents only under the margin scheme). */
  invoicedCents: number;
  /** Margin-scheme line: the margin VAT inside the invoiced price (null = unknown, no purchase cost). */
  marginScheme: { vatCents: number | null } | null;
  currency: string;
  supplier: SupplierRef;
  cost: SoldCost | null;
  marginCents: number | null;
  buyer: { name: string; company: string | null; email: string | null; vatId: string | null; country: string | null };
  poNumber: string | null;
  proformaNumber: string | null;
  invoice: { number: string; issueDate: Date } | null;
  /** Earlier invoices replaced by a corrected one (each credited in full). */
  replacedInvoices: string[];
  /** The credit notes of those replaced invoices: they net out with them, no amount. */
  replacementCreditNotes: string[];
  /** Credit notes of the current invoice (order level): the goods part excl. VAT, ≤ 0. */
  creditNotes: Array<{ number: string; issueDate: Date; goodsCents: number }>;
}

const ITEM_SELECT = {
  id: true,
  quantity: true,
  priceCentsSnapshot: true,
  titleSnapshot: true,
  brandSnapshot: true,
  basePriceCents: true,
  product: {
    select: {
      id: true,
      slug: true,
      sku: true,
      currency: true,
      vatScheme: true,
      purchaseCostCents: true,
      category: { select: { name: true, slug: true } },
      company: { select: { name: true, slug: true } },
      seller: { select: { id: true, name: true, role: true, company: { select: { name: true, slug: true } } } },
    },
  },
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      financialStatus: true,
      currency: true,
      vatTreatment: true,
      paidAt: true,
      shippedAt: true,
      deliveredAt: true,
      createdAt: true,
      buyerVatId: true,
      poNumber: true,
      proformaNumber: true,
      billingAddress: true,
      buyer: { select: { name: true, email: true } },
      sourcingRequest: {
        select: {
          productId: true,
          proformaNumber: true,
          offerSupplierCostCents: true,
          offerSupplierCostCurrency: true,
          sellerProposalCurrency: true,
          assignedTo: { select: { id: true, name: true, role: true, company: { select: { name: true, slug: true } } } },
        },
      },
      documents: {
        select: { id: true, kind: true, number: true, vatTreatment: true, originalDocumentId: true, issueDate: true, createdAt: true, subtotalCents: true, voidedAt: true, snapshot: true },
        orderBy: { createdAt: 'asc' },
      },
      items: { where: { product: { vatScheme: 'MARGIN' } }, select: MARGIN_ITEM_SELECT },
      _count: { select: { items: { where: { lineType: 'GOODS' } } } },
    },
  },
} satisfies Prisma.OrderItemSelect;

export type SoldItemRecord = Prisma.OrderItemGetPayload<{ select: typeof ITEM_SELECT }>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Bill-to party from the order's billing details (what the invoice prints). */
export function buyerOf(billing: unknown, account: { name: string | null; email: string | null }, vatId: string | null): SoldRow['buyer'] {
  const b = (billing && typeof billing === 'object' ? billing : {}) as Record<string, unknown>;
  const addr = (b.address && typeof b.address === 'object' ? b.address : b) as Record<string, unknown>;
  const acc = humaniseBuyer(account);
  const country = str(addr.country);
  return {
    name: str(b.name) ?? acc.primary,
    company: str(b.company),
    email: str(b.email) ?? (acc.anonymised ? null : account.email),
    vatId: vatId ?? str(b.vat) ?? str(b.vatId),
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country,
  };
}

/**
 * One register row from an order line. `marginRateBp`: the standard rate the
 * margin VAT of margin-scheme lines is computed at (as on the invoice).
 */
export function soldRowOf(it: SoldItemRecord, ownName: string, marginRateBp = 0): SoldRow {
  const o = it.order;
  const sr = o.sourcingRequest;
  const supplier = supplierOf(it.product, sr?.assignedTo ?? null, ownName);
  const chain = invoiceChain(o.documents);
  const current = chain.current;
  const invoiced = it.priceCentsSnapshot * it.quantity;
  // Margin scheme (the invoice, or the order before it): the margin VAT is inside the price.
  const marginLine = it.product?.vatScheme === 'MARGIN' && (current?.vatTreatment ?? o.vatTreatment) === 'MARGIN_SCHEME';
  const lineMargin = marginLine ? orderMarginOf([{ priceCentsSnapshot: it.priceCentsSnapshot, quantity: it.quantity, product: it.product }], marginRateBp) : null;
  const marginVat = lineMargin && !lineMargin.unitsWithoutCost ? lineMargin.vatCents : null;
  const net = invoiced - (marginVat ?? 0);
  const unit = marginVat ? Math.round(net / it.quantity) : it.priceCentsSnapshot;
  const quotedLine = !!sr && (sr.productId ? sr.productId === it.product?.id : o._count.items === 1);
  const cost = costOf({
    qty: it.quantity,
    orderCurrency: o.currency,
    basePriceCents: it.basePriceCents,
    supplierKind: supplier.kind,
    quote: sr,
    quotedLine,
    product: it.product ? { purchaseCostCents: it.product.purchaseCostCents, currency: it.product.currency } : null,
  });
  const margin = marginVatByDocument(o.documents, o.items, marginRateBp);
  const proforma = [...o.documents].reverse().find((d) => d.kind === 'PROFORMA' && !d.voidedAt) ?? null;
  return {
    itemId: it.id,
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    financialStatus: o.financialStatus,
    onTerms: ['INVOICED_ON_TERMS', 'OVERDUE', 'CREDIT_APPROVED', 'PARTIALLY_PAID'].includes(o.financialStatus) && !o.paidAt,
    saleAt: saleDateOf(o),
    paidAt: o.paidAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    productId: it.product?.id ?? null,
    productSlug: it.product?.slug ?? null,
    title: it.titleSnapshot,
    brand: it.brandSnapshot,
    sku: it.product?.sku ?? null,
    category: it.product?.category ?? null,
    qty: it.quantity,
    unitNetCents: unit,
    netCents: net,
    invoicedCents: invoiced,
    marginScheme: marginLine ? { vatCents: marginVat } : null,
    currency: o.currency,
    supplier,
    cost,
    // Margin VAT unknown: so is what the line earned.
    marginCents: marginLine && marginVat == null ? null : marginOf(net, o.currency, cost),
    buyer: buyerOf(o.billingAddress, o.buyer, o.buyerVatId),
    poNumber: o.poNumber,
    proformaNumber: o.proformaNumber ?? proforma?.number ?? sr?.proformaNumber ?? null,
    invoice: current ? { number: current.number, issueDate: current.issueDate } : null,
    replacedInvoices: chain.replaced.map((d) => d.number),
    replacementCreditNotes: chain.replacementCredits.map((d) => d.number),
    creditNotes: chain.credits.map((d) => ({
      number: d.number,
      issueDate: d.issueDate,
      goodsCents: docNetSplit(d).goodsCents - (margin.get(d.id)?.vatCents ?? 0),
    })),
  };
}

export interface SoldQuery {
  period: Period;
  tz: string;
  status: SoldStatusView;
  q?: string;
}

/** Every register row of the period (sale date) and status view, newest sale first. */
export async function loadSoldRows(f: SoldQuery, ownName: string): Promise<SoldRow[]> {
  const range = prefilterBounds(f.period);
  const dated = range.gte || range.lt;
  const q = (f.q ?? '').trim();
  const where: Prisma.OrderItemWhereInput = {
    lineType: 'GOODS',
    order: {
      status: { in: [...SOLD_STATUS_VIEWS[f.status].statuses] },
      ...(dated
        ? {
            OR: [
              { paidAt: range },
              { paidAt: null, createdAt: range },
              { documents: { some: { kind: 'INVOICE', issueDate: range } } },
            ],
          }
        : {}),
    },
    ...(q
      ? {
          OR: [
            { titleSnapshot: { contains: q, mode: 'insensitive' } },
            { brandSnapshot: { contains: q, mode: 'insensitive' } },
            { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
            { order: { proformaNumber: { contains: q, mode: 'insensitive' } } },
            { order: { documents: { some: { number: { contains: q, mode: 'insensitive' } } } } },
            { order: { buyer: { name: { contains: q, mode: 'insensitive' } } } },
            { order: { buyer: { email: { contains: q, mode: 'insensitive' } } } },
            { order: { buyerVatId: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  await ensureSettingsLoaded();
  const marginRateBp = marginVatRateBp();
  const items = await prisma.orderItem.findMany({ where, select: ITEM_SELECT });
  return items
    .map((it) => soldRowOf(it, ownName, marginRateBp))
    .filter((r) => inPeriod(r.saleAt, f.period, f.tz))
    .sort((a, b) => (b.saleAt?.getTime() ?? 0) - (a.saleAt?.getTime() ?? 0) || a.orderNumber.localeCompare(b.orderNumber));
}

/** Category and supplier filters (applied to loaded rows: the supplier is derived). */
export function filterSoldRows(rows: SoldRow[], f: { category?: string; supplier?: string }): SoldRow[] {
  return rows.filter(
    (r) =>
      (!f.category || (f.category === 'none' ? !r.category : r.category?.slug === f.category)) &&
      (!f.supplier || r.supplier.key === f.supplier),
  );
}

/** The categories and suppliers present in `rows` (filter options). */
export function soldFilterOptions(rows: SoldRow[]): { categories: Array<{ slug: string; name: string }>; suppliers: SupplierRef[] } {
  const cats = new Map<string, string>();
  const sups = new Map<string, SupplierRef>();
  for (const r of rows) {
    cats.set(r.category?.slug ?? 'none', r.category?.name ?? 'No category');
    sups.set(r.supplier.key, r.supplier);
  }
  return {
    categories: [...cats].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name)),
    suppliers: [...sups.values()].sort((a, b) => (a.kind === 'own' ? -1 : b.kind === 'own' ? 1 : a.name.localeCompare(b.name))),
  };
}

export interface SoldTotals {
  currency: string;
  units: number;
  netCents: number;
  /** Cost and margin of the rows whose cost is known in this currency. */
  costCents: number;
  marginCents: number;
  rowsWithMargin: number;
  rowsWithoutMargin: number;
  /** Credit notes of the current invoices of these orders (goods excl. VAT, ≤ 0; each order once). */
  creditedCents: number;
  /** Margin-scheme lines: the margin VAT taken off their invoiced price, and the lines where it is unknown. */
  marginVatCents: number;
  marginVatUnknown: number;
}

export function soldTotals(rows: SoldRow[]): SoldTotals[] {
  const map = new Map<string, SoldTotals>();
  const seen = new Set<string>();
  for (const r of rows) {
    const t = map.get(r.currency) ?? { currency: r.currency, units: 0, netCents: 0, costCents: 0, marginCents: 0, rowsWithMargin: 0, rowsWithoutMargin: 0, creditedCents: 0, marginVatCents: 0, marginVatUnknown: 0 };
    t.units += r.qty;
    t.netCents += r.netCents;
    if (r.marginScheme) {
      if (r.marginScheme.vatCents == null) t.marginVatUnknown += 1;
      else t.marginVatCents += r.marginScheme.vatCents;
    }
    if (r.marginCents != null && r.cost) {
      t.costCents += r.cost.cents;
      t.marginCents += r.marginCents;
      t.rowsWithMargin += 1;
    } else {
      t.rowsWithoutMargin += 1;
    }
    if (!seen.has(r.orderId)) {
      seen.add(r.orderId);
      t.creditedCents += r.creditNotes.reduce((s, c) => s + c.goodsCents, 0);
    }
    map.set(r.currency, t);
  }
  return [...map.values()].sort((a, b) => b.netCents - a.netCents);
}

export const SOLD_CSV_HEADER = [
  'sale_date',
  'paid_date',
  'shipped_date',
  'delivered_date',
  'order_number',
  'order_status',
  'payment',
  'product',
  'brand',
  'category',
  'sku',
  'qty',
  'unit_price_excl_vat',
  'line_total_excl_vat',
  'currency',
  'vat_scheme',
  'invoiced_line_total',
  'margin_vat_in_price',
  'supplier',
  'supplier_cost',
  'supplier_cost_currency',
  'supplier_cost_source',
  'margin',
  'buyer_company',
  'buyer_name',
  'buyer_email',
  'buyer_vat_id',
  'buyer_country',
  'po_number',
  'proforma_number',
  'invoice_number',
  'invoice_date',
  'replaced_invoice_numbers',
  'replacement_credit_note_numbers',
  'credit_note_numbers',
  'order_credit_notes_goods_excl_vat',
] as const;

/**
 * CSV rows in SOLD_CSV_HEADER order (dates as YYYY-MM-DD in the business time
 * zone). Credit notes belong to the order: their amount stands on the order's
 * first line only, so the column adds up.
 */
export function soldCsvRows(rows: SoldRow[], tz: string): string[][] {
  const day = (d: Date | null) => (d ? localDay(d, tz) : '');
  const credited = new Set<string>();
  const orderCredit = (r: SoldRow) => {
    if (!r.creditNotes.length || credited.has(r.orderId)) return '';
    credited.add(r.orderId);
    return csvMoney(r.creditNotes.reduce((s, c) => s + c.goodsCents, 0));
  };
  return rows.map((r) => [
    day(r.saleAt),
    day(r.paidAt),
    day(r.shippedAt),
    day(r.deliveredAt),
    r.orderNumber,
    r.status,
    r.onTerms ? 'on invoice terms (unpaid)' : r.paidAt ? 'paid' : '',
    r.title,
    r.brand ?? '',
    r.category?.name ?? '',
    r.sku ?? '',
    String(r.qty),
    csvMoney(r.unitNetCents),
    csvMoney(r.netCents),
    r.currency,
    r.marginScheme ? 'margin scheme' : '',
    csvMoney(r.invoicedCents),
    r.marginScheme ? (r.marginScheme.vatCents == null ? 'unknown (no purchase cost)' : csvMoney(r.marginScheme.vatCents)) : '',
    r.supplier.name,
    csvMoney(r.cost?.cents),
    r.cost ? (r.cost.currency ?? 'not recorded') : '',
    r.cost?.source ?? '',
    csvMoney(r.marginCents),
    r.buyer.company ?? '',
    r.buyer.name,
    r.buyer.email ?? '',
    r.buyer.vatId ?? '',
    r.buyer.country ?? '',
    r.poNumber ?? '',
    r.proformaNumber ?? '',
    r.invoice?.number ?? '',
    day(r.invoice?.issueDate ?? null),
    r.replacedInvoices.join(' | '),
    r.replacementCreditNotes.join(' | '),
    r.creditNotes.map((c) => c.number).join(' | '),
    orderCredit(r),
  ]);
}
