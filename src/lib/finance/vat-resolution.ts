import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingPercentBp } from '@/lib/settings';
import { audit, notifyAdmins } from '@/lib/observability';
import { fmtDocMoney } from '@/lib/documents/render';
import { checkCountry } from '@/lib/compliance/country';
import { parseVatId, vatIdLooksValid } from '@/lib/tax/vatid';
import { recordManualVatValidation } from '@/lib/tax/vies';
import { resolveOrderVat } from '@/lib/tax/order';
import { vatTreatmentLabel, type VatTreatmentCode } from '@/lib/tax/determine';
import { chargedVat } from '@/lib/documents/snapshot';
import { ORDER_DOC_INCLUDE, creditedOnInvoice, issueCreditNote, orderInvoice, paymentFacts } from '@/lib/documents/issue';
import { sendOrderInvoice, invoiceMailSummary } from '@/lib/orders/internal';
import { billingAddressJson } from '@/lib/orders/details';
import { requestRefundTx } from './refunds';

/** Staff member acting (always a signed-in admin here). */
type Actor = { id: string; email: string };

/**
 * Resolving the VAT of a PAID order whose invoice was withheld (VAT review /
 * missing invoice details), per order — never by changing a global rule — and
 * correcting an invoice that is wrong (older “legacy” invoices included):
 *
 *  - applyVatRules:   the VAT rules for the order's current details decide; the
 *                     order's VAT and total follow, the invoice is issued. Paid
 *                     too much → a refund of the difference is requested; too
 *                     little → the invoice shows what is still due.
 *  - issueAsCharged:  staff confirm what was charged is right (a treatment that
 *                     fits the charged rate) with the reason — recorded on the
 *                     order and in the invoice's audit trail.
 *  - correctBilling:  fix the billing name / address / VAT ID before invoicing.
 *  - recordManualVies: staff confirm a VAT ID by hand (VIES down for days, proof on file).
 *  - correctInvoice:  credit note for the whole invoice + a corrected invoice
 *                     (rules or as charged) that names the one it replaces.
 */

const PAID = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
type Result = { ok: boolean; message: string };

async function loadPaidOrder(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, include: ORDER_DOC_INCLUDE });
}

function onTerms(o: { financialStatus: string; paymentMethodManual: string | null }) {
  return ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID', 'CREDIT_APPROVED'].includes(o.financialStatus) && (o.paymentMethodManual ?? '').toUpperCase() === 'INVOICE';
}

/** The treatments staff may confirm for what an order was charged (the charged rate must fit). */
export function treatmentsForCharged(o: { subtotalCents: number; shippingCents: number; taxCents: number }, buyerVatId: string | null): { rateBp: number | null; options: VatTreatmentCode[] } {
  const cv = chargedVat(o.subtotalCents, o.shippingCents, o.taxCents, settingPercentBp('DEFAULT_TAX_PERCENT'), [settingPercentBp('TAX_STANDARD_RATE_PCT'), 900]);
  const rate = cv.goodsRateBp;
  if (rate == null) return { rateBp: null, options: [] };
  if (rate === 0) return { rateBp: 0, options: buyerVatId ? ['EXPORT_ZERO', 'EU_ICS_ZERO'] : ['EXPORT_ZERO'] };
  if (rate === settingPercentBp('TAX_STANDARD_RATE_PCT')) return { rateBp: rate, options: ['DOMESTIC_STANDARD', 'EU_B2C_HOME'] };
  return { rateBp: rate, options: ['EU_B2C_OSS', 'DOMESTIC_STANDARD'] };
}

function guardNotInvoiced(o: { status: string; financialStatus: string; paymentMethodManual: string | null; orderNumber: string }, hasInvoice: boolean, correcting: boolean): string | null {
  if (!PAID.includes(o.status) && !onTerms(o)) return `Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — only a paid order (or one approved on invoice terms) is invoiced.`;
  if (hasInvoice && !correcting) return `Order ${o.orderNumber} already has its invoice — correct it with “Correct invoice” (credit note + corrected invoice).`;
  return null;
}

/**
 * The VAT rules decide (live VIES for the buyer's VAT ID): the order's VAT and
 * total follow and the invoice is issued and e-mailed. Money: paid more than
 * the corrected total → a refund of the difference is requested (no credit
 * note — the invoice is right from the start); paid less → the invoice shows
 * what is still due.
 */
export async function applyVatRules(orderId: string, actor: Actor, note: string, opts: { correcting?: boolean } = {}): Promise<Result> {
  await ensureSettingsLoaded();
  if (note.trim().length < 4) return { ok: false, message: 'Record why (at least 4 characters) — it is kept with the VAT decision.' };
  const o = await loadPaidOrder(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  const existing = await orderInvoice(prisma, o.id);
  const why = guardNotInvoiced(o, !!existing && !(opts.correcting && existing && (await creditedOnInvoice(prisma, existing.id)) >= existing.totalCents), !!opts.correcting);
  if (why) return { ok: false, message: why };
  const res = await resolveOrderVat(o, { ignoreRecorded: true });
  const d = res.decision;
  if (d.blocked) return { ok: false, message: `The VAT rules refuse this sale: ${d.reasons.join(' ')}` };
  if (d.reviewRequired) return { ok: false, message: `The rules still cannot decide: ${d.reasons.join(' ')} Record the VAT ID check by hand (with your evidence), correct the billing details, or confirm the VAT as charged.` };
  const goods = d.lines.filter((l, i) => i < o.items.length);
  const newTax = d.taxCents;
  const newTotal = o.subtotalCents + o.shippingCents + newTax;
  const pay = paymentFacts(o);
  const paid = pay.paidCents;
  const snap = (o.pricingSnapshot ?? {}) as Record<string, unknown>;
  const adjustments = [...(Array.isArray(snap.adjustments) ? (snap.adjustments as unknown[]) : []), {
    at: new Date().toISOString(), by: actor.email, reason: `VAT decided after payment (rules): ${note}`,
    before: { taxCents: o.taxCents, totalCents: o.totalCents, vatTreatment: o.vatTreatment },
    after: { taxCents: newTax, totalCents: newTotal, vatTreatment: d.treatment },
  }];
  const overpaid = paid > 0 && !onTerms(o) ? paid - newTotal : 0;
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < o.items.length; i++) {
      await tx.orderItem.update({ where: { id: o.items[i].id }, data: { vatRateBp: goods[i]?.rateBp ?? 0, taxCents: goods[i]?.taxCents ?? 0 } });
    }
    await tx.order.update({
      where: { id: o.id },
      data: {
        taxCents: newTax,
        totalCents: newTotal,
        vatTreatment: d.treatment,
        vatRateBp: d.rateBp,
        shippingVatRateBp: d.shippingRateBp,
        shippingTaxed: d.shippingRateBp > 0,
        vatDecidedAt: new Date(),
        vatNote: `${d.reasons.join(' ')} Staff (${actor.email}): ${note}`.slice(0, 2000),
        ...(res.vatId ? { buyerVatId: res.vatId.vatId, viesCheck: JSON.parse(JSON.stringify(res.vatId)) as Prisma.InputJsonValue } : {}),
        pricingSnapshot: { ...snap, adjustments } as Prisma.InputJsonValue,
        ...(paid > 0 && paid < newTotal && !onTerms(o) ? { financialStatus: 'PARTIALLY_PAID' as const } : {}),
      },
    });
    if (overpaid > 0) {
      // The refund ledger (lib/finance/refunds.ts): REQUESTED until staff mark the transfer sent.
      await requestRefundTx(tx, { orderId: o.id, amountCents: overpaid, currency: o.currency, method: o.stripePaymentIntentId ? 'STRIPE' : 'BANK_TRANSFER', reason: `VAT corrected after payment: ${note}`, actorId: actor.id });
    }
  });
  const inv = await sendOrderInvoice(o.id, { actorId: actor.id, vatDecision: { kind: 'RULES', note, actorEmail: actor.email }, ...(opts.correcting ? { replaceCredited: { reason: `Corrected invoice: ${note}` } } : {}) });
  await audit('order.vat.rules', o.orderNumber, `${d.treatment} tax ${o.taxCents}→${newTax} total ${o.totalCents}→${newTotal} by ${actor.email}: ${note}`.slice(0, 500));
  const cur = (c: number) => fmtDocMoney(c, o.currency);
  const money = overpaid > 0
    ? ` The buyer paid ${cur(paid)}: a refund of ${cur(overpaid)} is REQUESTED — transfer it and mark it sent (Refunds).`
    : paid > 0 && paid < newTotal && !onTerms(o) ? ` The buyer paid ${cur(paid)}: ${cur(newTotal - paid)} is still due (shown on the invoice).` : '';
  if (overpaid > 0) await notifyAdmins(`Order ${o.orderNumber}: refund ${cur(overpaid)} to send (VAT corrected)`, `VAT decided by the rules after payment by ${actor.email}.`, `/admin/orders/${o.id}`, 'ORDER_REFUNDED');
  return {
    ok: inv.issued,
    message: `VAT decided by the rules: ${vatTreatmentLabel(d.treatment)}${d.rateBp ? ` ${d.rateBp / 100}%` : ''} — VAT ${cur(newTax)}, total ${cur(newTotal)} (was ${cur(o.totalCents)}).${money} ${invoiceMailSummary(inv)}`,
  };
}

/** Staff confirm the charged VAT is right: the invoice is issued as charged under a treatment that fits the charged rate. */
export async function issueAsCharged(orderId: string, actor: Actor, treatment: VatTreatmentCode, note: string, opts: { correcting?: boolean } = {}): Promise<Result> {
  await ensureSettingsLoaded();
  if (note.trim().length < 10) return { ok: false, message: 'Record why the charged VAT is right (at least 10 characters, e.g. what your accountant confirmed) — it is kept with the invoice.' };
  const o = await loadPaidOrder(orderId);
  if (!o) return { ok: false, message: 'Order not found.' };
  const existing = await orderInvoice(prisma, o.id);
  const why = guardNotInvoiced(o, !!existing && !(opts.correcting && existing && (await creditedOnInvoice(prisma, existing.id)) >= existing.totalCents), !!opts.correcting);
  if (why) return { ok: false, message: why };
  const fit = treatmentsForCharged(o, o.buyerVatId);
  if (!fit.options.includes(treatment)) {
    return { ok: false, message: fit.rateBp == null ? 'The charged VAT does not match any rate, so it cannot be confirmed as charged — apply the VAT rules instead.' : `“${vatTreatmentLabel(treatment)}” does not fit the ${fit.rateBp / 100}% that was charged. Choose one of: ${fit.options.map(vatTreatmentLabel).join(', ')}.` };
  }
  if (treatment === 'EU_ICS_ZERO' && !(o.buyerVatId && vatIdLooksValid(o.buyerVatId))) return { ok: false, message: 'Intra-EU 0% needs the buyer’s VAT ID on the invoice — add it under “Billing details” first.' };
  const inv = await sendOrderInvoice(o.id, { actorId: actor.id, vatDecision: { kind: 'AS_CHARGED', treatment, note, actorEmail: actor.email }, ...(opts.correcting ? { replaceCredited: { reason: `Corrected invoice: ${note}` } } : {}) });
  await audit('order.vat.as-charged', o.orderNumber, `${treatment} by ${actor.email}: ${note}`.slice(0, 500));
  return { ok: inv.issued, message: `VAT confirmed as charged (${vatTreatmentLabel(treatment)}) — your reason is kept with the invoice. ${invoiceMailSummary(inv)}` };
}

export interface BillingCorrection {
  legalName: string;
  contactName: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  invoiceEmail: string;
}

/** Correct the billing details of a paid order before its invoice is issued (kept old → new). */
export async function correctBilling(orderId: string, actor: Actor, b: BillingCorrection): Promise<Result & { fieldErrors?: Record<string, string> }> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, financialStatus: true, paymentMethodManual: true, billingAddress: true, buyerVatId: true, invoiceEmail: true, poNumber: true, openHolds: true, holdReason: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  const existing = await orderInvoice(prisma, o.id);
  if (existing && (await creditedOnInvoice(prisma, existing.id)) < existing.totalCents) {
    return { ok: false, message: `Invoice ${existing.number} is issued — billing details on it never change. Use “Correct invoice” (credit note + corrected invoice) to issue one with the new details.` };
  }
  const fe: Record<string, string> = {};
  const t = (v: string, max: number) => v.trim().slice(0, max);
  const legalName = t(b.legalName, 200), contactName = t(b.contactName, 120), line1 = t(b.line1, 200), line2 = t(b.line2, 200), postalCode = t(b.postalCode, 24), city = t(b.city, 120);
  const country = t(b.country, 2).toUpperCase();
  const vatRaw = t(b.vatId, 30);
  const invoiceEmail = t(b.invoiceEmail, 200).toLowerCase();
  if (legalName.length < 2) fe.legalName = 'enter the legal name';
  if (line1.length < 3) fe.line1 = 'enter the street and number';
  if (postalCode.length < 2) fe.postalCode = 'enter the postal code';
  if (city.length < 2) fe.city = 'enter the city';
  if (!/^[A-Z]{2}$/.test(country)) fe.country = 'choose the country';
  if (vatRaw && !parseVatId(vatRaw)) fe.vatId = 'starts with the 2-letter country code';
  if (invoiceEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invoiceEmail)) fe.invoiceEmail = 'not an e-mail address';
  if (Object.keys(fe).length) return { ok: false, message: 'Check the highlighted fields.', fieldErrors: fe };
  const c = await checkCountry(country);
  if (c.mode === 'BLOCK') return { ok: false, message: c.reason, fieldErrors: { country: 'not allowed' } };
  const prev = o.billingAddress && typeof o.billingAddress === 'object' ? (o.billingAddress as Record<string, unknown>) : {};
  const vatId = vatRaw ? parseVatId(vatRaw)!.vatId : '';
  const next = {
    ...billingAddressJson({ legalName, contactName, line1, line2, postalCode, city, region: '', country, vatId, invoiceEmail: invoiceEmail || (o.invoiceEmail ?? ''), phone: typeof prev.phone === 'string' ? prev.phone : '', poNumber: o.poNumber ?? '' } as never),
    ...(typeof prev.kvk === 'string' && prev.kvk ? { kvk: prev.kvk } : {}),
  };
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: o.id }, data: { billingAddress: next as Prisma.InputJsonValue, buyerVatId: vatId || null, ...(invoiceEmail ? { invoiceEmail } : {}) } });
    await tx.addressChange.create({
      data: { orderId: o.id, kind: 'BILLING', oldValue: (o.billingAddress ?? undefined) as Prisma.InputJsonValue | undefined, newValue: next as Prisma.InputJsonValue, actorRole: 'STAFF', actorId: actor.id, reviewStatus: 'NONE', note: `Billing details corrected by staff before invoicing (${actor.email}).` },
    });
  });
  await audit('order.billing.correct', o.orderNumber, `${legalName} · ${country}${vatId ? ` · ${vatId}` : ''} by ${actor.email}`);
  const vatReview = o.holdReason === 'VAT_REVIEW' || o.openHolds.includes('VAT_REVIEW');
  const vatChanged = (vatId || null) !== (o.buyerVatId || null) || country !== String((prev.address as Record<string, unknown> | undefined)?.country ?? prev.country ?? '').toUpperCase();
  const next_step = vatReview || vatChanged
    ? 'Now apply the VAT rules (or confirm the VAT as charged) to issue the invoice.'
    : 'Now use “Try issuing again” to issue the invoice.';
  return { ok: true, message: `Billing details saved${c.mode === 'REVIEW' ? ` (note: ${c.reason})` : ''}. ${next_step}` };
}

/** Staff confirm the buyer's VAT ID by hand (VIES down for days; proof on file) — the evidence is kept. */
export async function recordManualVies(orderId: string, actor: Actor, input: { vatId: string; status: 'VALID' | 'INVALID'; note: string }): Promise<Result> {
  await ensureSettingsLoaded();
  if (input.note.trim().length < 10) return { ok: false, message: 'Describe the evidence (at least 10 characters), e.g. “VIES printout 3 Oct 2026, consultation WAPI…” or “KvK / company register extract on file”.' };
  const p = parseVatId(input.vatId);
  if (!p) return { ok: false, message: 'Enter the VAT ID with its country prefix, e.g. DE123456789.' };
  if (!vatIdLooksValid(p.vatId)) return { ok: false, message: `${p.vatId} does not have the format of a ${p.prefix} VAT ID.` };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, buyerVatId: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  const id = await recordManualVatValidation(p.vatId, input.status, actor.id, `${input.note.trim()} (order ${o.orderNumber}, by ${actor.email})`);
  if (o.buyerVatId !== p.vatId) await prisma.order.update({ where: { id: o.id }, data: { buyerVatId: p.vatId } });
  await audit('order.vies.manual', o.orderNumber, `${p.vatId} ${input.status} by ${actor.email}: ${input.note}`.slice(0, 500));
  return { ok: !!id, message: `${p.vatId} recorded as ${input.status === 'VALID' ? 'valid' : 'NOT valid'} by hand (evidence kept). Now apply the VAT rules to issue the invoice.` };
}

/**
 * What a VAT treatment prints on an invoice beyond the amounts: its legal text
 * (intra-EU 0%, export 0%, margin scheme, OSS) — or none (home-rate supplies:
 * DOMESTIC_STANDARD and EU_B2C_HOME print the same invoice). Two treatments in
 * the same class at the same rate and amount make the same invoice.
 */
export function vatInvoiceClass(t: string | null | undefined): 'ICS' | 'EXPORT' | 'MARGIN' | 'OSS' | 'HOME' | 'UNKNOWN' {
  switch (t) {
    case 'EU_ICS_ZERO': return 'ICS';
    case 'EXPORT_ZERO': return 'EXPORT';
    case 'MARGIN_SCHEME': return 'MARGIN';
    case 'EU_B2C_OSS': return 'OSS';
    case 'DOMESTIC_STANDARD':
    case 'EU_B2C_HOME': return 'HOME';
    default: return 'UNKNOWN';
  }
}

/**
 * Does the VAT the rules give for the new destination change the invoice?
 * Only when the VAT amount, the rate or the treatment's invoice class (its
 * legal text) differs — not when merely the code differs (a home-rate sale
 * labelled DOMESTIC_STANDARD vs EU_B2C_HOME at the same 21% is the same invoice).
 * Older orders priced before the VAT rules (no / legacy treatment) compare by amount.
 */
export function vatUnchangedAfterMove(
  d: { reviewRequired: boolean; blocked: boolean; taxCents: number; rateBp: number; treatment: string },
  charged: { taxCents: number; vatRateBp: number | null; treatment: string | null },
): boolean {
  if (d.reviewRequired || d.blocked || d.taxCents !== charged.taxCents) return false;
  if (charged.vatRateBp != null && charged.vatRateBp !== d.rateBp) return false;
  const cls = vatInvoiceClass(charged.treatment);
  return cls === 'UNKNOWN' || cls === vatInvoiceClass(d.treatment);
}

/**
 * The destination of a PAID order changed (staff edit, or a buyer change that
 * staff approve): when the VAT rules for the new destination change the
 * invoice (amount, rate or legal text — vatUnchangedAfterMove), the order goes
 * on VAT review (shipping stops) with the reason — never silently shipped
 * against a wrong invoice. When they do not, the check is recorded (audit) and
 * a VAT review an earlier destination check opened is released.
 */
export async function vatCheckAfterDestinationChange(orderId: string, actor?: Actor): Promise<string | null> {
  await ensureSettingsLoaded();
  const o = await loadPaidOrder(orderId);
  if (!o || !(PAID.includes(o.status) || onTerms(o))) return null;
  const d = (await resolveOrderVat(o, { ignoreRecorded: true })).decision;
  const inv = await orderInvoice(prisma, o.id);
  const invoiced = inv && (await creditedOnInvoice(prisma, inv.id)) < inv.totalCents ? inv : null;
  const chargedTreatment = (invoiced?.vatTreatment ?? o.vatTreatment) as string | null;
  if (vatUnchangedAfterMove(d, { taxCents: o.taxCents, vatRateBp: o.vatRateBp, treatment: chargedTreatment })) {
    const cur = (c: number) => fmtDocMoney(c, o.currency);
    await audit('order.vat.destination-check', o.orderNumber, `unchanged after the destination change: ${vatTreatmentLabel(d.treatment)} — VAT ${cur(d.taxCents)} as charged${invoiced ? ` on invoice ${invoiced.number}` : ''}`);
    const openReview = (o.holdNote ?? '').split(' | ').some((p) => p.startsWith('VAT_REVIEW: The destination changed after payment'));
    if (openReview && (o.openHolds.includes('VAT_REVIEW') || o.holdReason === 'VAT_REVIEW')) {
      const { releaseHold } = await import('@/lib/checkout/holds');
      await releaseHold(o.id, 'VAT_REVIEW', actor ?? { id: 'system', email: 'VAT check after the address change' }, `VAT unchanged for the new destination (${vatTreatmentLabel(d.treatment)}, ${cur(d.taxCents)}).`);
    }
    return null;
  }
  const cur = (c: number) => fmtDocMoney(c, o.currency);
  const what = d.taxCents !== o.taxCents
    ? `VAT ${cur(d.taxCents)} instead of the ${cur(o.taxCents)} charged`
    : `the same VAT amount (${cur(d.taxCents)}), but ${vatInvoiceClass(d.treatment) !== vatInvoiceClass(chargedTreatment) ? `under another legal basis than the ${vatTreatmentLabel(chargedTreatment ?? 'LEGACY_UNSPECIFIED')} charged` : `at ${d.rateBp / 100}% instead of ${(o.vatRateBp ?? 0) / 100}%`}`;
  const detail = d.reviewRequired || d.blocked
    ? `The destination changed after payment and the VAT rules cannot decide it automatically: ${d.reasons.join(' ')}`
    : `The destination changed after payment: the VAT rules now give ${vatTreatmentLabel(d.treatment)} — ${what}${invoiced ? ` on invoice ${invoiced.number}` : ''}. ${invoiced ? 'Correct the invoice (credit note + corrected invoice), or keep it with a recorded reason.' : 'Decide the VAT before the invoice is issued.'}`;
  const { addHold } = await import('@/lib/checkout/holds');
  await addHold(o.id, 'VAT_REVIEW', detail);
  await notifyAdmins(`Order ${o.orderNumber}: VAT review after an address change`, detail.slice(0, 400), `/admin/orders/${o.id}`, 'SYSTEM');
  return detail;
}

/** Staff keep the issued invoice although the destination changed (reason recorded) — releases the VAT review. */
export async function keepInvoiceAfterReview(orderId: string, actor: Actor, note: string): Promise<Result> {
  if (note.trim().length < 10) return { ok: false, message: 'Record why the invoice stays as it is (at least 10 characters).' };
  const inv = await orderInvoice(prisma, orderId);
  if (!inv) return { ok: false, message: 'This order has no invoice yet — decide the VAT to issue it instead.' };
  const { releaseHold } = await import('@/lib/checkout/holds');
  const r = await releaseHold(orderId, 'VAT_REVIEW', actor, `Invoice ${inv.number} kept: ${note}`);
  return { ok: r.ok, message: r.ok ? `Invoice ${inv.number} kept as issued — your reason is recorded. ${r.message}` : r.message };
}

/**
 * Correct an issued invoice (wrong VAT / details, older legacy invoices):
 * a credit note for the whole invoice — it says the invoice is replaced and no
 * money moves — then the corrected invoice (VAT by the rules, or as charged),
 * which names the invoice it replaces.
 */
export async function correctInvoice(orderId: string, actor: Actor, input: { reason: string; mode: 'RULES' | 'AS_CHARGED'; treatment?: VatTreatmentCode | null }): Promise<Result> {
  await ensureSettingsLoaded();
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 10) return { ok: false, message: 'Describe what is wrong on the invoice (at least 10 characters) — it is printed on the credit note.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, financialStatus: true, paymentMethodManual: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (!PAID.includes(o.status) && !onTerms(o)) return { ok: false, message: `Order ${o.orderNumber} is ${o.status.toLowerCase()} — a refunded or canceled order is corrected with a credit note only.` };
  const inv = await orderInvoice(prisma, o.id);
  if (!inv) return { ok: false, message: 'This order has no invoice to correct.' };
  const credited = await creditedOnInvoice(prisma, inv.id);
  if (credited > 0 && credited < inv.totalCents) return { ok: false, message: `Invoice ${inv.number} is already partly credited — a full correction would double-credit it. Credit the rest first, or contact your accountant.` };
  // Check the corrected invoice CAN be issued before crediting the old one.
  const full = await loadPaidOrder(o.id);
  if (!full) return { ok: false, message: 'Order not found.' };
  if (input.mode === 'RULES') {
    const d = (await resolveOrderVat(full, { ignoreRecorded: true })).decision;
    if (d.blocked || d.reviewRequired) return { ok: false, message: `Nothing was changed: the VAT rules cannot decide this order yet (${d.reasons.join(' ')}). Correct the billing details / record the VAT ID check first, or confirm the VAT as charged.` };
  } else {
    const fit = treatmentsForCharged(full, full.buyerVatId);
    if (!input.treatment || !fit.options.includes(input.treatment)) return { ok: false, message: `Nothing was changed: choose a VAT treatment that fits what was charged (${fit.options.map(vatTreatmentLabel).join(', ') || 'none fits — apply the VAT rules'}).` };
  }
  let cnNumber = '(earlier)';
  if (credited === 0) {
    const cn = await issueCreditNote({ orderId: o.id, amountCents: null, reason: `Invoice replaced: ${reason}`, refundMethod: null, money: { refundCents: 0, method: null }, actorId: actor.id, replacement: true });
    if (!cn.ok) return { ok: false, message: cn.message };
    cnNumber = cn.document.number;
  }
  const r = input.mode === 'RULES'
    ? await applyVatRules(o.id, actor, reason, { correcting: true })
    : await issueAsCharged(o.id, actor, input.treatment as VatTreatmentCode, reason, { correcting: true });
  await audit('order.invoice.correct', o.orderNumber, `${inv.number} credited by ${cnNumber}; corrected (${input.mode}) by ${actor.email}: ${reason}`.slice(0, 500));
  return { ok: r.ok, message: `Invoice ${inv.number} credited in full by ${cnNumber}. ${r.message}` };
}
