import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { LIVE_REFUND_STATUSES } from '@/lib/finance/held';
import { ensureSettingsLoaded } from '@/lib/settings';
import { MARGIN_ITEM_SELECT, marginVatByDocument, marginVatRateBp, orderMarginOf, type MarginItemInput } from './margin-vat';

/**
 * Revenue as the owner and the accountant read it: one rule for the
 * Overview, Analytics and the Sold register (D61).
 *
 *  - Per currency. EUR and USD are never added up: no exchange rate is
 *    stored with an order, so every figure is shown once per currency.
 *  - Excl. VAT. The goods subtotal; freight only when asked for (`freight`).
 *    Margin-scheme goods are sold with the VAT on the margin inside the
 *    price: that margin VAT (computed, never printed) is taken off.
 *  - Net of credit notes. A credit note counts on its own issue date.
 *  - Dated by the sale: the day the order was paid, or invoiced on terms when
 *    that came first. Not the day the order was created.
 *
 * With an invoice the documents are the truth: the first invoice is the sale,
 * and a later (corrected) invoice and every credit note change revenue on
 * their own date, so "credit & re-issue" nets out. An order without an invoice
 * yet (held for VAT review, legacy) counts its order totals once it is paid.
 * Money sent back without a credit note (credit notes switched off, or no
 * invoice) lowers revenue only beyond what was paid too much: an overpayment
 * that is returned never was revenue, because revenue counts the invoiced
 * amount, not the money received.
 */

/** Order states of a sale that stands (paid or later, not refunded / canceled). */
export const SOLD_ORDER_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;

export interface RevenueDocInput {
  id: string;
  kind: 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE';
  vatTreatment: string;
  /** Credit note: the invoice it credits · corrected invoice: the invoice it replaces. */
  originalDocumentId: string | null;
  issueDate: Date;
  createdAt: Date;
  /** Net amount (goods + freight, excl. VAT); negative on a credit note. */
  subtotalCents: number;
  totalCents: number;
  snapshot: unknown;
}

export interface RevenueRefundInput {
  amountCents: number;
  status: string;
  creditNoteId: string | null;
  createdAt: Date;
}

export interface RevenueOrderInput {
  id: string;
  currency: string;
  status: string;
  vatTreatment: string | null;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  amountPaidCents: number;
  paidAt: Date | null;
  createdAt: Date;
  documents: RevenueDocInput[];
  refunds: RevenueRefundInput[];
  /** The order's margin-scheme lines (others may be left out). */
  items: MarginItemInput[];
}

/** SALE: the order is sold · REINVOICE: a corrected invoice · CREDIT_NOTE · REFUND: money back without a credit note. */
export type RevenueEventKind = 'SALE' | 'REINVOICE' | 'CREDIT_NOTE' | 'REFUND';

export interface RevenueEvent {
  orderId: string;
  currency: string;
  at: Date;
  kind: RevenueEventKind;
  /** Excl. VAT; negative for credit notes and refunds. */
  goodsCents: number;
  freightCents: number;
}

const isInt = (v: unknown): v is number => Number.isInteger(v);

/** A document's net amount split into goods and freight (from its frozen totals). */
export function docNetSplit(d: Pick<RevenueDocInput, 'subtotalCents' | 'snapshot'>): { goodsCents: number; freightCents: number } {
  const snap = (d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {}) as {
    totals?: { shippingCents?: unknown };
    lines?: Array<{ lineType?: unknown; netCents?: unknown }>;
  };
  let freight = 0;
  if (snap.totals && isInt(snap.totals.shippingCents)) {
    freight = snap.totals.shippingCents;
  } else if (Array.isArray(snap.lines)) {
    for (const l of snap.lines) if (l?.lineType === 'SHIPPING' && isInt(l.netCents)) freight += l.netCents;
  }
  return { goodsCents: d.subtotalCents - freight, freightCents: freight };
}

type DatedDoc = Pick<RevenueDocInput, 'kind' | 'issueDate' | 'createdAt'>;
type ChainDoc = DatedDoc & { id: string; originalDocumentId: string | null };

const byDate = (a: DatedDoc, b: DatedDoc) =>
  a.issueDate.getTime() - b.issueDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime();

/** The order's invoices, oldest first (a corrected invoice follows the one it replaces). */
export function invoicesOf<T extends DatedDoc>(docs: T[]): T[] {
  return docs.filter((d) => d.kind === 'INVOICE').sort(byDate);
}

/**
 * The order's invoices and credit notes as the accountant reads them: the
 * current invoice (the last one), the invoices it replaced and the credit
 * notes that cancelled those (replaced invoice + its credit notes net to
 * zero, so they carry no amount), and the credit notes of the current
 * invoice — the only real credits. A credit note that names no invoice
 * (legacy) counts as a credit of the current one.
 */
export function invoiceChain<T extends ChainDoc>(docs: T[]): { current: T | null; replaced: T[]; replacementCredits: T[]; credits: T[] } {
  const invoices = invoicesOf(docs);
  const current = invoices[invoices.length - 1] ?? null;
  const replaced = invoices.slice(0, -1);
  const replacedIds = new Set(replaced.map((d) => d.id));
  const notes = docs.filter((d) => d.kind === 'CREDIT_NOTE').sort(byDate);
  return {
    current,
    replaced,
    replacementCredits: notes.filter((d) => d.originalDocumentId != null && replacedIds.has(d.originalDocumentId)),
    credits: notes.filter((d) => d.originalDocumentId == null || !replacedIds.has(d.originalDocumentId)),
  };
}

/**
 * When the order became a sale: paid, or invoiced on terms — whichever came
 * first. Without an invoice: the payment date; a legacy paid order without
 * one falls back to its creation date. Null = not sold.
 */
export function saleDateOf(o: { status: string; paidAt: Date | null; createdAt: Date; documents: DatedDoc[] }): Date | null {
  const inv = invoicesOf(o.documents)[0];
  if (inv) return o.paidAt && o.paidAt.getTime() < inv.issueDate.getTime() ? o.paidAt : inv.issueDate;
  if (!(SOLD_ORDER_STATUSES as readonly string[]).includes(o.status)) return null;
  return o.paidAt ?? o.createdAt;
}

/** Money received; orders paid before the payments ledger existed count their total. */
function paidCents(o: RevenueOrderInput): number {
  if (o.amountPaidCents > 0) return o.amountPaidCents;
  return o.paidAt ? o.totalCents : 0;
}

/**
 * Every revenue movement of one order (empty when it never was a sale).
 * `marginRateBp`: the standard rate the margin VAT of margin-scheme goods is
 * computed at (0 = none taken off).
 */
export function revenueEvents(o: RevenueOrderInput, opts: { marginRateBp?: number } = {}): RevenueEvent[] {
  const events: RevenueEvent[] = [];
  const add = (kind: RevenueEventKind, at: Date, split: { goodsCents: number; freightCents: number }) =>
    events.push({ orderId: o.id, currency: o.currency, at, kind, ...split });
  const invoices = invoicesOf(o.documents);
  const credits = o.documents.filter((d) => d.kind === 'CREDIT_NOTE');
  const sold = saleDateOf(o);
  if (!sold) return events;
  const rate = opts.marginRateBp ?? 0;
  if (invoices.length) {
    const margin = marginVatByDocument(o.documents, o.items, rate);
    const split = (d: RevenueDocInput) => {
      const s = docNetSplit(d);
      return { goodsCents: s.goodsCents - (margin.get(d.id)?.vatCents ?? 0), freightCents: s.freightCents };
    };
    invoices.forEach((inv, i) => add(i === 0 ? 'SALE' : 'REINVOICE', i === 0 ? sold : inv.issueDate, split(inv)));
    for (const cn of credits) add('CREDIT_NOTE', cn.issueDate, split(cn));
  } else {
    const marginVat = o.vatTreatment === 'MARGIN_SCHEME' ? orderMarginOf(o.items, rate).vatCents : 0;
    add('SALE', sold, { goodsCents: o.subtotalCents - marginVat, freightCents: o.shippingCents });
  }

  // Money back without a credit note: first what was paid too much, only the
  // rest takes part of the sale back (excl. VAT, split like the order).
  const live = o.refunds.filter((r) => (LIVE_REFUND_STATUSES as readonly string[]).includes(r.status));
  const loose = live.filter((r) => !r.creditNoteId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (loose.length && o.totalCents > 0) {
    const due = invoices.length
      ? invoices.reduce((s, d) => s + d.totalCents, 0) + credits.reduce((s, d) => s + d.totalCents, 0)
      : o.totalCents;
    const backWithCreditNote = live.filter((r) => r.creditNoteId).reduce((s, r) => s + r.amountCents, 0);
    let excess = Math.max(0, paidCents(o) - backWithCreditNote - due);
    for (const r of loose) {
      const fromExcess = Math.min(excess, r.amountCents);
      excess -= fromExcess;
      const ofSale = r.amountCents - fromExcess;
      if (ofSale <= 0) continue;
      add('REFUND', r.createdAt, {
        goodsCents: -Math.round((ofSale * o.subtotalCents) / o.totalCents),
        freightCents: -Math.round((ofSale * o.shippingCents) / o.totalCents),
      });
    }
  }
  return events;
}

/** An event's revenue: goods, plus freight when `freight` is on. */
export function revenueOf(e: Pick<RevenueEvent, 'goodsCents' | 'freightCents'>, freight = false): number {
  return e.goodsCents + (freight ? e.freightCents : 0);
}

export interface CurrencyRevenue {
  currency: string;
  /** Revenue excl. VAT, net of credit notes and refunds. */
  cents: number;
  /** Credit notes and refunds in the window (negative or 0). */
  creditedCents: number;
  /** Sales (orders) in the window and their value before credits. */
  sales: number;
  salesCents: number;
}

/** Revenue per currency in [from, to); the largest first. */
export function revenueByCurrency(events: RevenueEvent[], opts: { from?: Date | null; to?: Date | null; freight?: boolean } = {}): CurrencyRevenue[] {
  const map = new Map<string, CurrencyRevenue>();
  for (const e of events) {
    if (opts.from && e.at.getTime() < opts.from.getTime()) continue;
    if (opts.to && e.at.getTime() >= opts.to.getTime()) continue;
    const row = map.get(e.currency) ?? { currency: e.currency, cents: 0, creditedCents: 0, sales: 0, salesCents: 0 };
    const v = revenueOf(e, opts.freight);
    row.cents += v;
    if (e.kind === 'CREDIT_NOTE' || e.kind === 'REFUND') row.creditedCents += v;
    if (e.kind === 'SALE') {
      row.sales += 1;
      row.salesCents += v;
    }
    map.set(e.currency, row);
  }
  return [...map.values()].sort((a, b) => b.salesCents - a.salesCents || a.currency.localeCompare(b.currency));
}

/** Revenue of one currency per bucket, oldest first (bucket buckets-1 ends at `now`). */
export function revenueSeries(
  events: RevenueEvent[],
  opts: { currency: string; now: number; buckets: number; bucketMs: number; freight?: boolean },
): number[] {
  const out = new Array<number>(opts.buckets).fill(0);
  for (const e of events) {
    if (e.currency !== opts.currency) continue;
    const i = opts.buckets - 1 - Math.floor((opts.now - e.at.getTime()) / opts.bucketMs);
    if (i >= 0 && i < opts.buckets) out[i] += revenueOf(e, opts.freight);
  }
  return out;
}

/** Average sale value (before credits) per currency. */
export function averageSale(rows: CurrencyRevenue[]): Array<{ currency: string; cents: number }> {
  return rows.filter((r) => r.sales > 0).map((r) => ({ currency: r.currency, cents: Math.round(r.salesCents / r.sales) }));
}

/** "€12,150 · $13,280" — one amount per currency; `empty` when there is none. */
export function formatByCurrency(rows: Array<{ currency: string; cents: number }>, empty = formatPrice(0, 'EUR')): string {
  return rows.length ? rows.map((r) => formatPrice(r.cents, r.currency)).join(' · ') : empty;
}

const REVENUE_SELECT = {
  id: true,
  currency: true,
  status: true,
  vatTreatment: true,
  subtotalCents: true,
  shippingCents: true,
  totalCents: true,
  amountPaidCents: true,
  paidAt: true,
  createdAt: true,
  documents: {
    where: { kind: { in: ['INVOICE', 'CREDIT_NOTE'] } },
    select: { id: true, kind: true, vatTreatment: true, originalDocumentId: true, issueDate: true, createdAt: true, subtotalCents: true, totalCents: true, snapshot: true },
  },
  refunds: { select: { amountCents: true, status: true, creditNoteId: true, createdAt: true } },
  items: { where: { product: { vatScheme: 'MARGIN' } }, select: MARGIN_ITEM_SELECT },
} satisfies Prisma.OrderSelect;

/** Orders that were ever sold: paid (or later) or invoiced. */
const EVER_SOLD: Prisma.OrderWhereInput = {
  OR: [{ status: { in: [...SOLD_ORDER_STATUSES] } }, { documents: { some: { kind: 'INVOICE' } } }],
};

/** Revenue events at or after `since` (all time without it). */
export async function loadRevenueEvents(since?: Date | null): Promise<RevenueEvent[]> {
  const where: Prisma.OrderWhereInput = since
    ? {
        AND: [
          EVER_SOLD,
          {
            OR: [
              { paidAt: { gte: since } },
              { createdAt: { gte: since } },
              { documents: { some: { kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, issueDate: { gte: since } } } },
              { refunds: { some: { createdAt: { gte: since } } } },
            ],
          },
        ],
      }
    : EVER_SOLD;
  await ensureSettingsLoaded();
  const marginRateBp = marginVatRateBp();
  const orders = await prisma.order.findMany({ where, select: REVENUE_SELECT });
  const events = orders.flatMap((o) => revenueEvents(o, { marginRateBp }));
  return since ? events.filter((e) => e.at.getTime() >= since.getTime()) : events;
}
