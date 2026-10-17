'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { issueMissingCreditNote, previewRefund } from '@/lib/finance/refunds';
import { applyVatRules, correctBilling, correctInvoice, issueAsCharged, keepInvoiceAfterReview, recordManualVies } from '@/lib/finance/vat-resolution';
import { fmtDocMoney } from '@/lib/documents/render';
import type { VatTreatmentCode } from '@/lib/tax/determine';

/**
 * Admin server actions for money corrections and VAT decisions on ONE order
 * (refund / credit preview, missing credit note, VAT review resolution,
 * invoice correction). Thin wrappers: the rules live in lib/finance/*. Every
 * action checks its capability and reports exactly what happened. Recording a
 * refund / credit, “mark refund sent” and “confirm” are the refund-ledger
 * actions in ./fulfilment-actions.ts (createRefundAction, markRefundSentAction,
 * confirmRefundAction) — all on THE refund / credit core (lib/finance/refunds.ts).
 */

type Result = { ok: boolean; message: string; fieldErrors?: Record<string, string> };

/** "1.234,56" / "1234.56" / "€ 99" → cents (NaN when not a number). */
function euros(v: FormDataEntryValue | null): number {
  const raw = String(v ?? '').replace(/[€\s]/g, '');
  const norm = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  const n = Number(norm);
  return Number.isFinite(n) && norm !== '' ? Math.round(n * 100) : NaN;
}

async function refresh(orderId: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true, sourcingRequestId: true } });
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin');
  if (o) revalidatePath(`/app/orders/${o.orderNumber}`);
  if (o?.sourcingRequestId) revalidatePath(`/admin/quotes/${o.sourcingRequestId}`);
}

/** The exact amounts a refund / credit of the typed amount comes to (credit note with VAT per rate, unpaid part vs money) — shown before confirming. */
export async function previewCreditAction(orderId: string, amountText: string, method?: string): Promise<{ ok: boolean; message: string }> {
  await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const cents = euros(amountText);
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, message: '' };
  const pv = await previewRefund(orderId, cents);
  if (!pv.ok) return pv;
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { currency: true } });
  const cur = (c: number) => fmtDocMoney(c, o?.currency ?? 'EUR');
  const via = method === 'STRIPE' ? ' to the card (Stripe, at once)' : method === 'OTHER' ? ' by another method (you record it as sent)' : ' by bank transfer (you send it, then mark it sent)';
  const money = pv.refundCents === 0
    ? 'nothing is refunded (that amount had not been paid) — it is no longer due'
    : pv.receivableCents > 0 ? `${cur(pv.receivableCents)} of the unpaid amount is canceled first, ${cur(pv.refundCents)} is refunded${via}` : `${cur(pv.refundCents)} is refunded${via}`;
  const doc = pv.invoiceNumber
    ? `Credit note on ${pv.invoiceNumber}: ${cur(pv.netCents)} + VAT ${cur(pv.taxCents)} = ${cur(pv.grossCents)}${pv.grossCents !== cents ? ' (exact VAT per rate)' : ''}`
    : 'No invoice was issued: no credit note';
  return { ok: true, message: `${doc}; ${money}.` };
}

export async function issueMissingCreditNoteAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const r = await issueMissingCreditNote(orderId, String(formData.get('reason') ?? ''), { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return r;
}

// ── VAT review of a paid order / invoice correction (finance:manage) ─────────

export async function applyVatRulesAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const r = await applyVatRules(orderId, { id: s.user.id, email: s.user.email }, String(formData.get('note') ?? ''));
  await refresh(orderId);
  return r;
}

export async function issueAsChargedAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const treatment = String(formData.get('treatment') ?? '') as VatTreatmentCode;
  const r = await issueAsCharged(orderId, { id: s.user.id, email: s.user.email }, treatment, String(formData.get('note') ?? ''));
  await refresh(orderId);
  return r;
}

export async function correctBillingAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const g = (k: string) => String(formData.get(k) ?? '');
  const r = await correctBilling(orderId, { id: s.user.id, email: s.user.email }, {
    legalName: g('legalName'), contactName: g('contactName'), line1: g('line1'), line2: g('line2'), postalCode: g('postalCode'),
    city: g('city'), country: g('country'), vatId: g('vatId'), invoiceEmail: g('invoiceEmail'),
  });
  await refresh(orderId);
  return r;
}

export async function recordManualViesAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const status = String(formData.get('status') ?? '') === 'INVALID' ? 'INVALID' : 'VALID';
  const r = await recordManualVies(orderId, { id: s.user.id, email: s.user.email }, { vatId: String(formData.get('vatId') ?? ''), status, note: String(formData.get('note') ?? '') });
  await refresh(orderId);
  return r;
}

export async function keepInvoiceAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const r = await keepInvoiceAfterReview(orderId, { id: s.user.id, email: s.user.email }, String(formData.get('note') ?? ''));
  await refresh(orderId);
  return r;
}

export async function correctInvoiceAction(formData: FormData): Promise<Result> {
  const s = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const orderId = String(formData.get('orderId') ?? '');
  const mode = String(formData.get('mode') ?? '') === 'AS_CHARGED' ? 'AS_CHARGED' : 'RULES';
  const r = await correctInvoice(orderId, { id: s.user.id, email: s.user.email }, {
    reason: String(formData.get('reason') ?? ''),
    mode,
    treatment: (String(formData.get('treatment') ?? '') || null) as VatTreatmentCode | null,
  });
  await refresh(orderId);
  return r;
}
