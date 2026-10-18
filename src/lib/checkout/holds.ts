import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum, settingInt, settingString } from '@/lib/settings';
import { addDaysEndOfDay } from '@/lib/orders/payment-due';
import { checkCountry } from '@/lib/compliance/country';
import { quoteShippingFor } from '@/lib/shipping/load';
import { checkVatId } from '@/lib/tax/vies';
import { determineVat, taxOn, vatTreatmentLabel, type VatDecision } from '@/lib/tax/determine';
import { loadCountryFacts, loadTaxSettings } from '@/lib/tax/settings';
import { addressCountry } from '@/lib/tax/order';
import { audit, notifyUser } from '@/lib/observability';
import { formatPrice } from '@/lib/utils';
import { fillHoldText, primaryHold, type HoldCode } from './engine';
import { sendHoldReleased, holdTitle, type HoldReleasedMail } from './notify';

/**
 * Pre-payment holds of an order (A11 / A12 / VAT review) and how staff
 * resolve them. While any of these is open the order is NOT payable: no
 * proforma, no bank details, no card payment, no receipt upload.
 *
 *   SHIPPING_PENDING  set the freight (or re-run the zones after a table change)
 *   VAT_REVIEW        re-check the VAT (VIES) — decided automatically when possible
 *   COMPLIANCE        a person with compliance:clear releases it (with a note)
 *   ADDRESS_REVIEW    the buyer changed the destination: re-price + approve
 *   PAYMENT_REVIEW    money received does not match the order (Stripe)
 *
 * When the last pre-payment hold is released the buyer gets the final total
 * and the proforma (sendHoldReleased). The payment term restarts at that
 * moment (Order.payableSince + a new Order.dueAt): the buyer could not pay
 * while the order was on hold — for quote orders accepted on a compliance hold
 * (lib/quotes/actions.ts acceptOffer) as much as for checkout orders.
 */

/** Days a buyer has to pay once an order is payable: the accepted offer's term, else PAYMENT_TERM_DAYS. */
export function prepayTermDays(paymentTerms: unknown): number {
  const t = paymentTerms && typeof paymentTerms === 'object' ? (paymentTerms as Record<string, unknown>) : null;
  if (t?.kind === 'PREPAY' && typeof t.days === 'number' && t.days > 0) return t.days;
  return settingInt('PAYMENT_TERM_DAYS', 14);
}

/**
 * INVOICE_PENDING on an UNPAID order: its proforma could not be issued because
 * the seller's own legal / bank details are incomplete (lib/documents/issue.ts
 * sellerDetailsMissing) — not payable until staff complete them and issue it
 * (releasing it sends the proforma like any other pre-payment hold). Every
 * caller asks this for unpaid orders only.
 */
export const PRE_PAYMENT_HOLDS: readonly HoldCode[] = ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING', 'INVOICE_PENDING'];
type Actor = { id: string; email?: string | null };
type Result = { ok: boolean; message: string };

export function hasPrePaymentHold(o: { openHolds?: string[] | null; holdReason?: string | null }): boolean {
  const open = new Set([...(o.openHolds ?? []), ...(o.holdReason ? [o.holdReason] : [])]);
  return PRE_PAYMENT_HOLDS.some((h) => open.has(h));
}

/**
 * The only pre-payment hold of an unpaid order is INVOICE_PENDING: its total is
 * final, only the seller's payment details (Settings → Company / Payments) are
 * missing — pages say "payment details being prepared", not "total being
 * confirmed".
 */
export function sellerDetailsHoldOnly(o: { status: string; openHolds?: string[] | null; holdReason?: string | null }): boolean {
  if (o.status !== 'PENDING_PAYMENT') return false;
  const open = new Set([...(o.openHolds ?? []), ...(o.holdReason ? [o.holdReason] : [])]);
  return open.has('INVOICE_PENDING') && PRE_PAYMENT_HOLDS.every((h) => h === 'INVOICE_PENDING' || !open.has(h));
}

/**
 * Buyer title and text template of one hold (Settings → Checkout & customers).
 * INVOICE_PENDING: on an unpaid order the proforma waits for the seller's own
 * details (CHECKOUT_MSG_PAYMENT_DETAILS_PENDING); on a paid one the invoice is
 * withheld (CHECKOUT_MSG_INVOICE_PENDING). Sync — after ensureSettingsLoaded().
 */
export function buyerHoldText(code: string, o: { status: string }): { title: string; template: string } {
  if (code === 'INVOICE_PENDING') {
    return o.status === 'PENDING_PAYMENT'
      ? { title: 'Payment details being prepared', template: settingString('CHECKOUT_MSG_PAYMENT_DETAILS_PENDING') }
      : { title: 'Invoice being prepared', template: settingString('CHECKOUT_MSG_INVOICE_PENDING') };
  }
  const tpl: Record<string, string> = {
    SHIPPING_PENDING: settingString('CHECKOUT_MSG_SHIPPING_PENDING'),
    COMPLIANCE: settingString('CHECKOUT_MSG_COMPLIANCE_REVIEW'),
    VAT_REVIEW: settingString('CHECKOUT_MSG_VAT_REVIEW'),
    ADDRESS_REVIEW: settingString('CHECKOUT_MSG_ADDRESS_REVIEW'),
    PAYMENT_REVIEW: 'Our team is checking your payment against the order. We contact you if anything is needed.',
  };
  return { title: holdTitle(code), template: tpl[code] || holdTitle(code) };
}

/** Buyer-facing sentences for an order's open holds (Settings → Checkout & customers). */
export async function buyerHoldMessages(o: { status: string; openHolds: string[]; holdReason: string | null; shippingAddress: unknown; vatNote?: string | null }): Promise<Array<{ code: string; title: string; message: string }>> {
  await ensureSettingsLoaded();
  const codes = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  const country = addressCountry(o.shippingAddress);
  const name = country ? (await checkCountry(country)).name ?? country : null;
  return codes.map((c) => {
    const t = buyerHoldText(c, o);
    return { code: c, title: t.title, message: fillHoldText(t.template, { COUNTRY: name, REASON: null }) };
  });
}

function noteWithout(note: string | null, code: string): string | null {
  const parts = (note ?? '').split(' | ').filter((p) => p && !p.startsWith(`${code}:`));
  return parts.length ? parts.join(' | ') : null;
}

/** Put a hold on an order (inside the caller's transaction when given). */
export async function addHold(orderId: string, code: HoldCode, detail: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<void> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { openHolds: true, holdNote: true, holdReason: true } });
  if (!o) return;
  const open = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : []), code]));
  await db.order.update({
    where: { id: orderId },
    data: {
      openHolds: open,
      holdReason: primaryHold(open),
      holdNote: [noteWithout(o.holdNote, code), `${code}: ${detail}`].filter(Boolean).join(' | ').slice(0, 2000),
      holdAt: new Date(),
      ...(PRE_PAYMENT_HOLDS.includes(code) ? { payableSince: null } : {}),
    },
  });
}

/** Release one hold. When the last pre-payment hold goes, the buyer gets the final total. */
export async function releaseHold(orderId: string, code: HoldCode, actor: Actor, note: string): Promise<Result & { releasedAll?: boolean }> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, buyerId: true, openHolds: true, holdReason: true, holdNote: true, paymentSubmittedAt: true, paymentTerms: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  const open = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  if (!open.includes(code)) return { ok: false, message: `The order has no “${holdTitle(code)}” hold.` };
  const rest = open.filter((h) => h !== code);
  const next = primaryHold(rest);
  const stillPrePayment = rest.some((h) => (PRE_PAYMENT_HOLDS as readonly string[]).includes(h));
  const becamePayable = o.status === 'PENDING_PAYMENT' && !stillPrePayment && (PRE_PAYMENT_HOLDS as readonly string[]).includes(code);
  const now = new Date();
  const res = await prisma.order.updateMany({
    // CAS on the hold list: two staff members releasing at once can't both "win".
    where: { id: o.id, openHolds: { equals: o.openHolds } },
    data: {
      openHolds: rest,
      holdReason: next,
      holdNote: noteWithout(o.holdNote, code),
      holdAt: next ? new Date() : null,
      // Payable from now: the payment term (due date printed on the proforma,
      // used by the reminders and the auto-cancel sweep) starts again.
      ...(becamePayable ? { payableSince: now, dueAt: addDaysEndOfDay(now, prepayTermDays(o.paymentTerms)) } : {}),
    },
  });
  if (res.count !== 1) return { ok: false, message: 'The order changed meanwhile — reload the page and try again.' };
  await audit('order.hold.release', o.orderNumber, `${code} by ${actor.email ?? actor.id}: ${note}`.slice(0, 500));
  if (!becamePayable) {
    return { ok: true, message: `${holdTitle(code)} released.${rest.length ? ` Still open: ${rest.map(holdTitle).join(', ')}.` : ''}` };
  }
  const mail = await sendHoldReleased(o.id);
  const outcome = holdReleaseOutcome(code, mail);
  if (outcome.payable) {
    await notifyUser(o.buyerId, `Order ${o.orderNumber}: final total ready`, 'Your order is confirmed. You can now pay — the payment details are on your order page.', `/app/orders/${o.orderNumber}/payment`);
  }
  return { ok: true, releasedAll: outcome.payable, message: outcome.message };
}

/**
 * What releasing the last pre-payment hold led to (staff message; `payable`:
 * the buyer is told they can now pay). SELLER_INCOMPLETE: the proforma could
 * not be issued because the seller's own details are incomplete — the order is
 * back on the INVOICE_PENDING hold, not payable, nothing was mailed, and the
 * buyer is NOT told to pay.
 */
export function holdReleaseOutcome(code: string, mail: Pick<HoldReleasedMail, 'emailed' | 'proforma' | 'note' | 'code'>): { payable: boolean; message: string } {
  if (mail.code === 'SELLER_INCOMPLETE') {
    return {
      payable: false,
      message: `${holdTitle(code)} released, but the order is on hold again: the proforma (payment request) waits for the company / payment details (Settings → Company / Payments & credit terms). Nothing is due for the buyer and nothing was e-mailed.${mail.note ? ` ${mail.note}` : ''}`,
    };
  }
  return {
    payable: true,
    message: `${holdTitle(code)} released — the order is now payable. ${mail.proforma ? `Proforma ${mail.proforma} ` : 'The proforma could not be issued' + (mail.note ? ` (${mail.note})` : '') + '; '}${mail.emailed ? 'emailed to the buyer.' : 'the email to the buyer could NOT be sent — contact them.'}`,
  };
}

// ── re-pricing (unpaid checkout orders) ──────────────────────────────────────

const ORDER_PRICING_INCLUDE = { items: { include: { product: { select: { vatScheme: true, shippingClass: true, weightKg: true } } } } } satisfies Prisma.OrderInclude;
type PricedOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_PRICING_INCLUDE }>;

function repriceable(o: PricedOrder): string | null {
  if (o.status !== 'PENDING_PAYMENT') return `The order is ${o.status.toLowerCase().replace(/_/g, ' ')} — its amounts can no longer change here (corrections after payment are credit notes).`;
  if (o.paymentSubmittedAt) return 'The buyer already submitted a payment for this order — reject or verify that payment first.';
  if (o.sourcingRequestId) return 'This order comes from an accepted quote: its shipping and VAT are those of the offer. Change them through the quote.';
  return null;
}

async function decideVat(o: PricedOrder, shippingCents: number): Promise<{ decision: VatDecision; viesCheck: Prisma.InputJsonValue | undefined; vatId: string | null }> {
  const ship = addressCountry(o.shippingAddress);
  const bill = addressCountry(o.billingAddress) ?? ship;
  const business = o.customerType !== 'CONSUMER';
  const raw = business ? o.buyerVatId ?? ((o.billingAddress as { vat?: string } | null)?.vat ?? null) : null;
  const vies = raw ? await checkVatId(raw) : null;
  const [s, countries] = await Promise.all([loadTaxSettings(), loadCountryFacts()]);
  const decision = determineVat(
    {
      shipToCountry: ship,
      billingCountry: bill,
      customerKind: business ? 'BUSINESS' : 'CONSUMER',
      vatId: vies && vies.country ? vies : null,
      lines: [
        ...o.items.map((i) => ({ netCents: i.priceCentsSnapshot * i.quantity, lineType: 'GOODS' as const, scheme: i.product?.vatScheme === 'MARGIN' ? ('MARGIN' as const) : ('STANDARD' as const) })),
        ...(shippingCents > 0 ? [{ netCents: shippingCents, lineType: 'SHIPPING' as const }] : []),
      ],
    },
    s,
    countries,
  );
  const viesCheck = vies
    ? ({ vatId: vies.vatId, status: vies.status, name: vies.name ?? null, consultationNumber: vies.consultationNumber ?? null, source: vies.source, checkedAt: vies.checkedAt ?? null, error: vies.error ?? null } as Prisma.InputJsonValue)
    : undefined;
  return { decision, viesCheck, vatId: vies?.vatId ?? null };
}

async function writePricing(o: PricedOrder, shippingCents: number, d: VatDecision, extra: { viesCheck?: Prisma.InputJsonValue; vatId?: string | null; reason: string; actor: Actor }) {
  const goods = d.lines.filter((l) => l.lineType !== 'SHIPPING');
  const ship = d.lines.find((l) => l.lineType === 'SHIPPING');
  const taxCents = d.taxCents;
  const total = o.subtotalCents + shippingCents + taxCents;
  const snap = (o.pricingSnapshot ?? {}) as Record<string, unknown>;
  const adjustments = Array.isArray(snap.adjustments) ? (snap.adjustments as unknown[]) : [];
  adjustments.push({
    at: new Date().toISOString(), by: extra.actor.email ?? extra.actor.id, reason: extra.reason,
    before: { shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents, vatTreatment: o.vatTreatment },
    after: { shippingCents, taxCents, totalCents: total, vatTreatment: d.treatment },
  });
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < o.items.length; i++) {
      await tx.orderItem.update({ where: { id: o.items[i].id }, data: { vatRateBp: goods[i]?.rateBp ?? 0, taxCents: goods[i]?.taxCents ?? 0 } });
    }
    await tx.order.update({
      where: { id: o.id },
      data: {
        shippingCents,
        taxCents,
        totalCents: total,
        vatTreatment: d.treatment,
        vatRateBp: d.rateBp,
        shippingVatRateBp: d.shippingRateBp,
        shippingTaxed: (ship?.rateBp ?? d.shippingRateBp) > 0,
        vatDecidedAt: new Date(),
        vatNote: d.reasons.join(' ').slice(0, 2000),
        ...(extra.viesCheck ? { viesCheck: extra.viesCheck } : {}),
        ...(extra.vatId !== undefined ? { buyerVatId: extra.vatId } : {}),
        pricingSnapshot: { ...snap, adjustments } as Prisma.InputJsonValue,
      },
    });
  });
  return { taxCents, total };
}

/** Staff set the freight of an order whose shipping is "to be confirmed". */
export async function setOrderFreight(orderId: string, shippingCents: number, actor: Actor, note: string): Promise<Result> {
  await ensureSettingsLoaded();
  if (!Number.isInteger(shippingCents) || shippingCents < 0 || shippingCents > 10_000_000) return { ok: false, message: 'Enter the shipping cost in euros (0 or more).' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_PRICING_INCLUDE });
  if (!o) return { ok: false, message: 'Order not found.' };
  const why = repriceable(o);
  if (why) return { ok: false, message: why };
  const vatOpen = o.openHolds.includes('VAT_REVIEW') || o.vatTreatment === 'REVIEW_REQUIRED';
  if (vatOpen) {
    // VAT not decided yet: store the freight; the VAT on it follows when the VAT is decided.
    await prisma.order.update({ where: { id: o.id }, data: { shippingCents, totalCents: o.subtotalCents + shippingCents + o.taxCents } });
  } else {
    const rate = o.shippingVatRateBp ?? o.vatRateBp ?? 0;
    const itemTax = o.items.reduce((s, i) => s + (i.taxCents ?? taxOn(i.priceCentsSnapshot * i.quantity, i.vatRateBp ?? rate)), 0);
    const taxCents = itemTax + taxOn(shippingCents, rate);
    const snap = (o.pricingSnapshot ?? {}) as Record<string, unknown>;
    const adjustments = [...(Array.isArray(snap.adjustments) ? (snap.adjustments as unknown[]) : []), {
      at: new Date().toISOString(), by: actor.email ?? actor.id, reason: `Freight set: ${note}`,
      before: { shippingCents: o.shippingCents, taxCents: o.taxCents, totalCents: o.totalCents },
      after: { shippingCents, taxCents, totalCents: o.subtotalCents + shippingCents + taxCents },
    }];
    await prisma.order.update({
      where: { id: o.id },
      data: { shippingCents, taxCents, totalCents: o.subtotalCents + shippingCents + taxCents, pricingSnapshot: { ...snap, adjustments } as Prisma.InputJsonValue },
    });
  }
  await audit('order.freight.set', o.orderNumber, `${shippingCents} by ${actor.email ?? actor.id}: ${note}`.slice(0, 500));
  const fresh = await prisma.order.findUnique({ where: { id: o.id }, select: { totalCents: true, currency: true } });
  const head = `Shipping set to ${formatPrice(shippingCents, o.currency)}; order total now ${formatPrice(fresh?.totalCents ?? 0, o.currency)}${vatOpen ? ' (VAT still to be decided)' : ''}.`;
  if (o.openHolds.includes('SHIPPING_PENDING') || o.holdReason === 'SHIPPING_PENDING') {
    const r = await releaseHold(o.id, 'SHIPPING_PENDING', actor, `freight ${shippingCents}`);
    return { ok: r.ok, message: `${head} ${r.message}` };
  }
  return { ok: true, message: head };
}

/** Re-check the VAT (VIES live) for an unpaid checkout order and apply it when the rules can decide. */
export async function recheckOrderVat(orderId: string, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_PRICING_INCLUDE });
  if (!o) return { ok: false, message: 'Order not found.' };
  const why = repriceable(o);
  if (why) return { ok: false, message: why };
  const { decision, viesCheck, vatId } = await decideVat(o, o.shippingCents);
  if (decision.blocked) return { ok: false, message: `The VAT rules refuse this sale: ${decision.reasons.join(' ')}` };
  if (decision.reviewRequired) return { ok: false, message: `Still undecided: ${decision.reasons.join(' ')} Try again later, or record the VAT ID by hand (Settings → Tax & VAT) once you have the evidence.` };
  const r = await writePricing(o, o.shippingCents, decision, { viesCheck, vatId, reason: 'VAT re-checked', actor });
  await audit('order.vat.recheck', o.orderNumber, `${decision.treatment} ${decision.rateBp} tax=${r.taxCents} by ${actor.email ?? actor.id}`);
  const head = `VAT decided: ${vatTreatmentLabel(decision.treatment)}${decision.rateBp ? ` ${(decision.rateBp / 100).toString()}%` : ''} — VAT ${formatPrice(r.taxCents, o.currency)}, total ${formatPrice(r.total, o.currency)}.`;
  if (o.openHolds.includes('VAT_REVIEW') || o.holdReason === 'VAT_REVIEW') {
    const rel = await releaseHold(o.id, 'VAT_REVIEW', actor, decision.reasons.join(' '));
    return { ok: rel.ok, message: `${head} ${rel.message}` };
  }
  return { ok: true, message: head };
}

/** After a destination change: shipping from the zones + VAT again, then approve the change. */
export async function approveAddressChange(orderId: string, actor: Actor, note: string): Promise<Result> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_PRICING_INCLUDE });
  if (!o) return { ok: false, message: 'Order not found.' };
  const country = addressCountry(o.shippingAddress);
  const c = await checkCountry(country);
  if (c.mode === 'BLOCK') return { ok: false, message: `${c.reason} The address cannot be approved — ask the buyer for another destination or cancel the order.` };
  const parts: string[] = [];
  if (!repriceable(o)) {
    // Unpaid checkout order: shipping and VAT follow the new destination.
    const sq = await quoteShippingFor(country, o.items.map((i) => ({ qty: i.quantity, shippingClass: i.product?.shippingClass ?? null, weightKg: i.product?.weightKg ?? null, valueCents: i.priceCentsSnapshot * i.quantity })), o.currency);
    let shippingCents = o.shippingCents;
    if (sq.status === 'QUOTED') {
      shippingCents = sq.amountCents;
      parts.push(`Shipping ${formatPrice(shippingCents, o.currency)} (${sq.reasons[0] ?? 'zone rate'}).`);
    } else if (sq.status === 'NOT_SHIPPABLE') {
      return { ok: false, message: `No shipping to ${c.name ?? country}: ${sq.reasons.join(' ')} Cancel the order or ask for another address.` };
    } else {
      await addHold(o.id, 'SHIPPING_PENDING', sq.reasons.join(' '));
      parts.push('Shipping to the new destination has no rate — set the freight by hand.');
    }
    const { decision, viesCheck, vatId } = await decideVat(o, shippingCents);
    if (decision.reviewRequired || decision.blocked) {
      await addHold(o.id, 'VAT_REVIEW', decision.reasons.join(' '));
      parts.push(`VAT needs a decision: ${decision.reasons.join(' ')}`);
    } else {
      const r = await writePricing(o, shippingCents, decision, { viesCheck, vatId, reason: `Address change approved: ${note}`, actor });
      parts.push(`VAT ${vatTreatmentLabel(decision.treatment)}; total now ${formatPrice(r.total, o.currency)}.`);
    }
  } else if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status)) {
    // Paid order: amounts and the invoice stay; when the VAT rules for the new
    // destination differ, the order goes on VAT review (shipping stops) until
    // staff correct the invoice or record why it stays.
    const { vatCheckAfterDestinationChange } = await import('@/lib/finance/vat-resolution');
    const vatNote = await vatCheckAfterDestinationChange(o.id);
    if (vatNote) parts.push(`On VAT review: ${vatNote}`);
  } else {
    // Unpaid quote order: amounts stay; report what the VAT rules say now.
    const { decision } = await decideVat(o, o.shippingCents);
    if (!decision.reviewRequired && decision.taxCents !== o.taxCents) {
      parts.push(`Note: the VAT rules for the new destination give ${formatPrice(decision.taxCents, o.currency)} VAT (${vatTreatmentLabel(decision.treatment)}) instead of the ${formatPrice(o.taxCents, o.currency)} charged.`);
    }
  }
  if (c.mode === 'REVIEW' && !o.openHolds.includes('COMPLIANCE')) {
    await addHold(o.id, 'COMPLIANCE', c.reason);
    parts.push('The new destination needs an export-compliance review.');
  }
  await prisma.addressChange.updateMany({ where: { orderId: o.id, reviewStatus: 'PENDING' }, data: { reviewStatus: 'APPROVED', reviewedById: actor.id, reviewedAt: new Date() } });
  const r = await releaseHold(o.id, 'ADDRESS_REVIEW', actor, note);
  return { ok: r.ok, message: `${parts.join(' ')} ${r.message}`.trim() };
}

// ── address changes (A12): one rule for every write path ─────────────────────

export type AddressChangeVerdict =
  | { ok: false; code: 'BLOCKED' | 'NEVER' | 'SAME_COUNTRY'; message: string }
  | { ok: true; hold: HoldCode | null; reviewStatus: 'NONE' | 'PENDING'; note: string; countryChanged: boolean };

/**
 * May this order's delivery address change to `nextCountry`, and what follows?
 * BLOCK destinations are refused everywhere. A buyer's change of country goes
 * to staff review (and, after payment, follows POST_PAYMENT_ADDRESS_CHANGE).
 * Staff changes are allowed and re-checked.
 */
export async function evaluateAddressChange(
  order: { status: string; shippingAddress: unknown; openHolds: string[] },
  nextCountry: string,
  actor: 'BUYER' | 'STAFF',
): Promise<AddressChangeVerdict> {
  await ensureSettingsLoaded();
  const c = await checkCountry(nextCountry);
  if (c.mode === 'BLOCK') return { ok: false, code: 'BLOCKED', message: c.reason };
  const before = addressCountry(order.shippingAddress);
  const countryChanged = !!before && before !== c.country;
  const paid = ['PAID', 'PROCESSING'].includes(order.status);
  const notes: string[] = [];
  let hold: HoldCode | null = null;
  if (actor === 'BUYER' && paid && countryChanged) {
    const policy = settingEnum<'WITH_REVIEW' | 'SAME_COUNTRY' | 'NEVER'>('POST_PAYMENT_ADDRESS_CHANGE');
    if (policy === 'NEVER') return { ok: false, code: 'NEVER', message: 'The delivery address of a paid order cannot be changed online. Please contact us.' };
    if (policy === 'SAME_COUNTRY') return { ok: false, code: 'SAME_COUNTRY', message: `After payment the address can only change within ${before}. For another country, please contact us.` };
  }
  const unpaid = order.status === 'PENDING_PAYMENT';
  if (countryChanged && (actor === 'BUYER' || unpaid)) {
    // A new destination changes the shipping zone, the VAT and the export
    // checks: an unpaid order is re-priced before payment is requested; a
    // buyer's change after payment stops fulfilment until staff approve it.
    hold = 'ADDRESS_REVIEW';
    notes.push(`Destination changed ${before} → ${c.country} by ${actor === 'BUYER' ? 'the buyer' : 'staff'}${paid ? ' after payment' : ''}: VAT, shipping and export checks must be redone.`);
  } else if (countryChanged) {
    notes.push(`Destination changed ${before} → ${c.country} by staff after payment: check that the VAT on the invoice still fits the new destination (credit note + new invoice if not).`);
  }
  if (c.mode === 'REVIEW' && !order.openHolds.includes('COMPLIANCE')) {
    hold = hold ?? 'COMPLIANCE';
    notes.push(c.reason);
  }
  return { ok: true, hold, reviewStatus: hold ? 'PENDING' : 'NONE', note: notes.join(' ') || 'Same destination country.', countryChanged };
}

/** Write the change history row and the hold(s) the verdict asks for. */
export async function recordAddressChange(
  db: Prisma.TransactionClient | typeof prisma,
  p: { orderId: string; kind: 'SHIPPING' | 'BILLING'; oldValue: unknown; newValue: unknown; actorRole: 'BUYER' | 'STAFF'; actorId: string | null; verdict: Extract<AddressChangeVerdict, { ok: true }>; nextCountry: string },
): Promise<void> {
  await db.addressChange.create({
    data: {
      orderId: p.orderId,
      kind: p.kind,
      oldValue: (p.oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
      newValue: (p.newValue ?? {}) as Prisma.InputJsonValue,
      actorRole: p.actorRole,
      actorId: p.actorId,
      reviewStatus: p.verdict.reviewStatus,
      note: p.verdict.note.slice(0, 1000),
    },
  });
  if (p.verdict.hold === 'ADDRESS_REVIEW') await addHold(p.orderId, 'ADDRESS_REVIEW', p.verdict.note, db);
  const c = await checkCountry(p.nextCountry);
  if (c.mode === 'REVIEW') {
    const o = await db.order.findUnique({ where: { id: p.orderId }, select: { openHolds: true } });
    if (o && !o.openHolds.includes('COMPLIANCE')) await addHold(p.orderId, 'COMPLIANCE', c.reason, db);
  }
}

/** Clear an export-compliance hold (compliance:clear), with the reason. */
export async function clearComplianceHold(orderId: string, actor: Actor, note: string): Promise<Result> {
  if (note.trim().length < 4) return { ok: false, message: 'Write down what was checked (at least a few words) — it is kept as the compliance record.' };
  const r = await releaseHold(orderId, 'COMPLIANCE', actor, note.trim());
  if (r.ok) {
    // The compliance record also goes on the order's internal notes (who, when, what was checked).
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { adminNotes: true } });
    await prisma.order.update({
      where: { id: orderId },
      data: { adminNotes: `${o?.adminNotes ? `${o.adminNotes}\n` : ''}[${new Date().toISOString().slice(0, 10)}] Compliance hold cleared by ${actor.email ?? actor.id}: ${note.trim()}`.slice(0, 4000) },
    }).catch(() => null);
  }
  return r;
}
