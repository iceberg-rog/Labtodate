import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingPercentBp } from '@/lib/settings';
import { vatInMargin } from '@/lib/tax/determine';

/**
 * Margin-scheme VAT (second-hand goods). The price includes the VAT on the
 * margin and no document prints it: issueInvoice records it only as audit
 * text. The reports compute it the same way — per margin-scheme unit, the
 * standard rate's share of (sale price − purchase cost), nothing on a negative
 * margin — so the VAT summary and revenue can show it. A unit without a
 * purchase cost has an unknown margin VAT: it is counted, never guessed. The
 * rate is the standard rate setting (TAX_STANDARD_RATE_PCT), as on the invoice.
 */

export interface MarginItemInput {
  priceCentsSnapshot: number;
  quantity: number;
  product: { vatScheme: string; purchaseCostCents: number | null } | null;
}

export interface OrderMargin {
  /** The margin incl. its VAT (positive margins only). */
  marginCents: number;
  vatCents: number;
  /** Margin-scheme units without a purchase cost (their margin VAT is not included). */
  unitsWithoutCost: number;
}

/** The order's margin and margin VAT, per unit as issueInvoice records it. */
export function orderMarginOf(items: MarginItemInput[], rateBp: number): OrderMargin {
  const out: OrderMargin = { marginCents: 0, vatCents: 0, unitsWithoutCost: 0 };
  for (const it of items) {
    if (it.product?.vatScheme !== 'MARGIN') continue;
    if (it.product.purchaseCostCents == null) {
      out.unitsWithoutCost += it.quantity;
      continue;
    }
    const margin = (it.priceCentsSnapshot - it.product.purchaseCostCents) * it.quantity;
    if (margin > 0) out.marginCents += margin;
    out.vatCents += vatInMargin(margin, rateBp);
  }
  return out;
}

export interface MarginVat {
  rateBp: number;
  /** The taxable margin excl. VAT (the base of the margin VAT); negative on a credit note. */
  baseCents: number;
  /** Margin VAT owed; negative on a credit note. */
  vatCents: number;
  unitsWithoutCost: number;
}

/** A printed VAT row that taxes something (freight); a 0% row on a margin-scheme document holds the goods. */
export function isTaxedRow(r: { rateBp: number | null; taxCents: number }): boolean {
  return r.rateBp !== 0 || r.taxCents !== 0;
}

/** The goods of a margin-scheme document: its net minus what its printed VAT rows tax. */
export function marginGoodsOf(d: { subtotalCents: number; snapshot: unknown }): number {
  const snap = (d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {}) as { vat?: { rows?: Array<{ rateBp?: unknown; baseCents?: unknown; taxCents?: unknown }> } };
  const rows = Array.isArray(snap.vat?.rows) ? snap.vat.rows : [];
  let taxed = 0;
  for (const r of rows) {
    if (!Number.isInteger(r?.baseCents) || !Number.isInteger(r?.taxCents)) continue;
    if (isTaxedRow({ rateBp: Number.isInteger(r.rateBp) ? (r.rateBp as number) : null, taxCents: r.taxCents as number })) taxed += r.baseCents as number;
  }
  return d.subtotalCents - taxed;
}

export interface MarginDocInput {
  id: string;
  kind: string;
  vatTreatment: string;
  originalDocumentId: string | null;
  issueDate: Date;
  createdAt: Date;
  subtotalCents: number;
  snapshot: unknown;
}

const byDate = (a: MarginDocInput, b: MarginDocInput) => a.issueDate.getTime() - b.issueDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime();

/**
 * Margin VAT per margin-scheme invoice and credit note of one order. Every
 * invoice (a corrected one too) owes the order's margin VAT. A credit note
 * lowers the price, so the margin, by the goods it credits: it takes back the
 * margin VAT that goes with that, and the credit notes that close an invoice
 * take back exactly its margin VAT.
 */
export function marginVatByDocument(docs: MarginDocInput[], items: MarginItemInput[], rateBp: number): Map<string, MarginVat> {
  const out = new Map<string, MarginVat>();
  const margin = docs.filter((d) => d.vatTreatment === 'MARGIN_SCHEME');
  if (!margin.length) return out;
  const m = orderMarginOf(items, rateBp);
  const invoices = margin.filter((d) => d.kind === 'INVOICE').sort(byDate);
  for (const inv of invoices) out.set(inv.id, { rateBp, baseCents: m.marginCents - m.vatCents, vatCents: m.vatCents, unitsWithoutCost: m.unitsWithoutCost });
  // What is left of the margin once `credited` goods are credited on an invoice of `goods`.
  const left = (credited: number, goods: number) => {
    if (credited <= 0) return { margin: m.marginCents, vat: m.vatCents };
    if (credited >= goods) return { margin: 0, vat: 0 };
    const rest = Math.max(0, m.marginCents - credited);
    return { margin: rest, vat: vatInMargin(rest, rateBp) };
  };
  const credited = new Map<string, number>();
  for (const cn of margin.filter((d) => d.kind === 'CREDIT_NOTE').sort(byDate)) {
    const inv = invoices.find((i) => i.id === cn.originalDocumentId) ?? invoices.filter((i) => byDate(i, cn) <= 0).pop() ?? invoices[0];
    if (!inv) continue;
    const goods = marginGoodsOf(inv);
    const before = credited.get(inv.id) ?? 0;
    const after = before - marginGoodsOf(cn);
    credited.set(inv.id, after);
    const b = left(before, goods);
    const a = left(after, goods);
    out.set(cn.id, { rateBp, baseCents: a.margin - a.vat - (b.margin - b.vat), vatCents: a.vat - b.vat, unitsWithoutCost: m.unitsWithoutCost });
  }
  return out;
}

export const MARGIN_DOC_SELECT = {
  id: true,
  kind: true,
  vatTreatment: true,
  originalDocumentId: true,
  issueDate: true,
  createdAt: true,
  subtotalCents: true,
  snapshot: true,
} satisfies Prisma.FiscalDocumentSelect;

export const MARGIN_ITEM_SELECT = {
  priceCentsSnapshot: true,
  quantity: true,
  product: { select: { vatScheme: true, purchaseCostCents: true } },
} satisfies Prisma.OrderItemSelect;

/** The standard rate the margin VAT is computed at (settings must be loaded). */
export function marginVatRateBp(): number {
  return settingPercentBp('TAX_STANDARD_RATE_PCT');
}

/** Margin VAT of every margin-scheme invoice and credit note of these orders, by document id. */
export async function loadMarginVat(orderIds: string[]): Promise<Map<string, MarginVat>> {
  const out = new Map<string, MarginVat>();
  const ids = [...new Set(orderIds)];
  if (!ids.length) return out;
  await ensureSettingsLoaded();
  const rateBp = marginVatRateBp();
  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    select: {
      items: { select: MARGIN_ITEM_SELECT },
      documents: { where: { kind: { in: ['INVOICE', 'CREDIT_NOTE'] } }, select: MARGIN_DOC_SELECT },
    },
  });
  for (const o of orders) for (const [id, v] of marginVatByDocument(o.documents, o.items, rateBp)) out.set(id, v);
  return out;
}
