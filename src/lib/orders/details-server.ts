import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { escapeHtml } from '@/lib/email-html';
import { formatPrice } from '@/lib/utils';
import { audit, logError, notifyAdmins } from '@/lib/observability';
import { documentAttachment, getOrderDocuments, reissueProforma } from '@/lib/documents/issue';
import type { VatLineInput } from '@/lib/tax/determine';
import { decideVatForDetails } from '@/lib/quotes/engine';
import { addHold, evaluateAddressChange, hasPrePaymentHold, recordAddressChange, type AddressChangeVerdict } from '@/lib/checkout/holds';
import { addressCountry } from '@/lib/tax/order';
import { emailProformaRevision, paymentTermDays, vatIdRule } from '@/lib/quotes/policy';
import { mailLayout, siteBase } from '@/lib/quotes/mail';
import { billingAddressJson, detailsDiffer, orderDetailsProblems, shippingAddressJson, type DetailsFieldErrors, type OrderDetails } from './details';
import { effectiveDueDate, fmtDueDate } from './payment-due';
import { mailOrderDocument, recipientsLabel } from './internal';

/**
 * Save the billing + delivery details of an UNPAID order (buyer on the payment
 * page, or staff on the order page). Server-internal: the caller checks who
 * may do this. Re-checks the country policy and, for orders priced by the VAT
 * rules, the VAT; when anything printed on the proforma changes a new proforma
 * revision replaces the old one and is emailed to the order's document
 * recipients (the accounts-payable address, a copy to the account).
 *
 * One address rule for every write path (s2a, A12 — lib/checkout/holds.ts):
 *  - every change is kept old → new (AddressChange), BLOCK countries are refused,
 *    REVIEW countries put the order on a COMPLIANCE pre-payment hold (openHolds);
 *  - a CHECKOUT order's delivery country can not be switched by the buyer while
 *    paying (it changes the zone shipping and the VAT); staff may switch it, which
 *    puts the order on ADDRESS_REVIEW until "Re-price & approve" (zone shipping +
 *    VAT for the new destination);
 *  - a QUOTE order's freight, Incoterm and place were quoted for one destination
 *    (the offer's destination country, else the address it was accepted with):
 *    the buyer can not move it to another country ("ask us for a new offer");
 *    staff may, which puts the order on ADDRESS_REVIEW — no proforma revision
 *    goes out until the freight, Incoterm and place are re-quoted (or staff
 *    approve that they still apply). The VAT follows the details (s2b).
 * While a pre-payment hold is open no proforma revision is issued: the release
 * of the last hold issues and emails it (lib/checkout/notify.ts sendHoldReleased).
 */

/** The destination country the accepted offer was priced for (offerTerms.destinationCountry), when stated. */
export function offerDestinationCountry(offerTerms: unknown): string | null {
  const t = offerTerms && typeof offerTerms === 'object' ? (offerTerms as Record<string, unknown>) : null;
  const c = typeof t?.destinationCountry === 'string' ? t.destinationCountry.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

export const QUOTE_COUNTRY_LOCKED = 'The delivery country of an accepted offer cannot be changed here. Ask us for a new offer.';

/**
 * The destination rule of an unpaid order's details save (pure):
 *  - `pricedFor`: the country the order was priced for — its delivery country,
 *    or, before there is one, the destination country the accepted offer states;
 *  - a buyer moving it to another country is refused (checkout and quote orders);
 *  - staff moving a QUOTE order: `quoteReview` — ADDRESS_REVIEW, no revision
 *    until the freight, Incoterm and place are re-quoted.
 */
export function destinationChangeRule(p: { isQuote: boolean; prevShip: string | null; offerDestination: string | null; nextShip: string; actor: 'BUYER' | 'STAFF' }):
  | { refused: { error: string; fieldErrors: DetailsFieldErrors } }
  | { refused: null; pricedFor: string | null; countryChanged: boolean; quoteReview: boolean } {
  const pricedFor = p.prevShip ?? (p.isQuote ? p.offerDestination : null);
  const countryChanged = !!pricedFor && pricedFor !== p.nextShip;
  if (countryChanged && p.actor === 'BUYER') {
    return {
      refused: p.isQuote
        ? { error: `${QUOTE_COUNTRY_LOCKED} Nothing was saved.`, fieldErrors: { d_country: `stays ${pricedFor} for this offer` } }
        : {
            error: 'The delivery country cannot be changed while paying: it changes the shipping and VAT of this order. Nothing was saved — contact us to change the destination.',
            fieldErrors: { d_country: `stays ${pricedFor} for this order` },
          },
    };
  }
  return { refused: null, pricedFor, countryChanged, quoteReview: p.isQuote && countryChanged };
}

export type SaveDetailsResult = { error?: string; notice?: string; warning?: string; fieldErrors?: DetailsFieldErrors; revision?: string | null };

export async function saveOrderDetails(
  orderId: string,
  d: OrderDetails,
  opts: { actor: { id: string; email: string; kind: 'BUYER' | 'STAFF' }; saveProfile: boolean },
): Promise<SaveDetailsResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { product: { select: { vatScheme: true } } }, orderBy: { id: 'asc' } },
      buyer: { select: { id: true, email: true, name: true } },
      sourcingRequest: { select: { id: true, validUntilAt: true, offerTerms: true } },
    },
  });
  if (!order) return { error: 'Order not found.' };
  if (order.status !== 'PENDING_PAYMENT') {
    return { error: order.status === 'CANCELED' ? 'This order is canceled.' : 'The order is already paid — the billing details are on its invoice; contact support to change the delivery address.' };
  }
  if (order.paymentVerificationStatus === 'AWAITING_VERIFICATION') {
    return { error: opts.actor.kind === 'BUYER' ? 'Your payment receipt is being verified, so the details are locked. Contact support if something must change.' : 'A payment receipt is waiting for verification — verify or reject it first.' };
  }

  const isQuote = !!order.sourcingRequestId;
  const prevShip = addressCountry(order.shippingAddress);
  const nextShip = d.delivery.country;
  const rule = destinationChangeRule({ isQuote, prevShip, offerDestination: offerDestinationCountry(order.sourcingRequest?.offerTerms), nextShip, actor: opts.actor.kind });
  if (rule.refused) return rule.refused;
  const { pricedFor } = rule;
  const v = await evaluateAddressChange(order, nextShip, opts.actor.kind);
  if (!v.ok) return { error: v.message, fieldErrors: { d_country: 'not allowed' } };
  const verdict: Extract<AddressChangeVerdict, { ok: true }> = rule.quoteReview
    ? {
        ...v,
        hold: 'ADDRESS_REVIEW',
        reviewStatus: 'PENDING',
        countryChanged: true,
        note: `Destination of the accepted offer changed ${pricedFor} → ${nextShip} by staff before payment: its freight, Incoterm and place were quoted for ${pricedFor}. Re-quote them (cancel the order and send a new offer), or approve the change if they still apply — no proforma revision is issued until then.`,
      }
    : v;
  // Moved to another country by staff: a checkout order's shipping + VAT are
  // re-priced on approval (holds.ts approveAddressChange), not here; a quote
  // order waits for the freight / Incoterm re-quote (its VAT follows now).
  const addressReview = verdict.hold === 'ADDRESS_REVIEW';

  const lines: VatLineInput[] = order.items.map((i) => ({
    netCents: i.priceCentsSnapshot * i.quantity,
    lineType: (i.lineType === 'SHIPPING' || i.lineType === 'SERVICE' || i.lineType === 'DISCOUNT' ? i.lineType : 'GOODS') as VatLineInput['lineType'],
    scheme: i.product?.vatScheme === 'MARGIN' ? 'MARGIN' : 'STANDARD',
  }));
  if (order.shippingCents > 0 && !lines.some((l) => l.lineType === 'SHIPPING')) lines.push({ netCents: order.shippingCents, lineType: 'SHIPPING' });
  const vat = await decideVatForDetails(d, lines, { isBusiness: order.customerType ? order.customerType !== 'CONSUMER' : undefined });
  for (const c of [vat.shipTo, vat.billing]) {
    if (c?.mode === 'BLOCK') return { error: `${c.reason}${opts.actor.kind === 'BUYER' ? ' Contact support if this is not right.' : ''}`, fieldErrors: { [c === vat.shipTo ? 'd_country' : 'b_country']: 'not allowed' } };
  }
  // Engine-priced orders (quote acceptance, new checkout) follow the rules for
  // the new details; interim flat-rate orders keep their amount (checked when invoiced).
  const enginePriced = (!addressReview || isQuote) && !!order.vatTreatment && order.vatTreatment !== 'LEGACY_UNSPECIFIED' && order.vatRateBp != null;
  const dec = vat.decision;
  if (enginePriced && (dec.blocked || dec.reviewRequired)) {
    return { error: `The VAT can not be determined for these details right now: ${dec.reasons.join(' ')} Try again later${opts.actor.kind === 'BUYER' ? ', or contact support' : ''}.` };
  }
  const newTax = enginePriced ? dec.taxCents : order.taxCents;
  const newTotal = enginePriced ? order.subtotalCents + order.shippingCents + newTax : order.totalCents;
  // Keep what checkout stored next to the details (e.g. the KvK number).
  const prevBill = order.billingAddress && typeof order.billingAddress === 'object' ? (order.billingAddress as Record<string, unknown>) : {};
  const billing = { ...billingAddressJson(d.billing), ...(typeof prevBill.kvk === 'string' && prevBill.kvk ? { kvk: prevBill.kvk } : {}) };
  const shipping = shippingAddressJson(d.delivery, order.buyer.email);
  const before = { billingAddress: order.billingAddress, shippingAddress: order.shippingAddress };
  const changedDetails = detailsDiffer(before, { billingAddress: billing, shippingAddress: shipping });
  const amountChanged = newTotal !== order.totalCents;
  const review = [vat.shipTo, vat.billing].find((c) => c?.mode === 'REVIEW');

  const claim = await prisma.$transaction(async (tx) => {
    const r = await tx.order.updateMany({
      // (NULL-safe: a plain NOT(x = 'A') is false for NULL in SQL.)
      where: { id: order.id, status: 'PENDING_PAYMENT', OR: [{ paymentVerificationStatus: null }, { paymentVerificationStatus: { not: 'AWAITING_VERIFICATION' } }] },
      data: {
        billingAddress: billing as Prisma.InputJsonValue,
        shippingAddress: shipping as Prisma.InputJsonValue,
        ...(enginePriced
          ? {
              taxCents: newTax,
              totalCents: newTotal,
              vatTreatment: dec.treatment,
              vatRateBp: dec.rateBp,
              vatDecidedAt: new Date(),
              vatNote: dec.reasons.join(' ').slice(0, 1000),
              buyerVatId: vat.vatId?.vatId ?? d.billing.vatId,
              viesCheck: vat.vatId ? (JSON.parse(JSON.stringify(vat.vatId)) as Prisma.InputJsonValue) : Prisma.DbNull,
              // The freight's own VAT rate (7a), so the documents print one row per rate.
              ...(order.shippingCents > 0 ? { shippingVatRateBp: dec.shippingRateBp, shippingTaxed: dec.shippingRateBp > 0 } : {}),
            }
          : {}),
        // Where invoices go and the buyer's PO — the same columns checkout fills (7a).
        invoiceEmail: d.billing.invoiceEmail,
        poNumber: d.billing.poNumber,
      },
    });
    if (r.count !== 1) return 0;
    // A12: history old → new + the holds the rule asks for (ADDRESS_REVIEW, COMPLIANCE).
    if (JSON.stringify(before.shippingAddress ?? null) !== JSON.stringify(shipping)) {
      await recordAddressChange(tx, { orderId: order.id, kind: 'SHIPPING', oldValue: before.shippingAddress, newValue: shipping, actorRole: opts.actor.kind, actorId: opts.actor.id, verdict, nextCountry: nextShip });
    }
    if (JSON.stringify(before.billingAddress ?? null) !== JSON.stringify(billing)) {
      await recordAddressChange(tx, {
        orderId: order.id, kind: 'BILLING', oldValue: before.billingAddress, newValue: billing, actorRole: opts.actor.kind, actorId: opts.actor.id,
        verdict: { ok: true, hold: null, reviewStatus: 'NONE', note: 'Billing details updated before payment.', countryChanged: false }, nextCountry: d.billing.country,
      });
    }
    // (Only when the details really changed: re-saving the same details of an
    // order whose compliance check was already cleared does not re-open it.)
    if (review && changedDetails) {
      const now = await tx.order.findUnique({ where: { id: order.id }, select: { openHolds: true, holdReason: true } });
      if (now && !now.openHolds.includes('COMPLIANCE') && now.holdReason !== 'COMPLIANCE') {
        await addHold(order.id, 'COMPLIANCE', `Export compliance check before payment: ${review.reason}`.slice(0, 1000), tx);
      }
    }
    if (enginePriced) {
      const goods = dec.lines.filter((l) => l.lineType !== 'SHIPPING');
      for (const [i, it] of order.items.entries()) {
        const l = goods[i];
        if (l) await tx.orderItem.update({ where: { id: it.id }, data: { vatRateBp: l.rateBp, taxCents: l.taxCents } });
      }
    }
    if (opts.saveProfile) {
      const profile = {
        customerType: 'BUSINESS' as const,
        legalName: d.billing.legalName,
        contactName: d.billing.contactName,
        vatId: d.billing.vatId,
        vatValidationId: vat.vatId?.validationId ?? null,
        address: { line1: d.billing.line1, line2: d.billing.line2, postalCode: d.billing.postalCode, city: d.billing.city, region: d.billing.region, country: d.billing.country } as Prisma.InputJsonValue,
        country: d.billing.country,
        invoiceEmail: d.billing.invoiceEmail,
        phone: d.billing.phone,
      };
      await tx.billingProfile.upsert({ where: { userId: order.buyerId }, update: profile, create: { userId: order.buyerId, ...profile } });
    }
    return 1;
  });
  if (claim !== 1) return { error: 'The order changed meanwhile (receipt uploaded or canceled). Reload the page.' };

  // A new proforma revision when anything printed on it changed — unless the
  // order is now on a pre-payment hold: the release of the last hold issues it.
  const docs = await getOrderDocuments(order.id);
  const after = await prisma.order.findUnique({ where: { id: order.id }, select: { openHolds: true, holdReason: true } });
  const heldNow = !!after && hasPrePaymentHold(after);
  let revision: string | null = null;
  let revisionMail: 'sent' | 'failed' | 'off' | null = null;
  let revisionError: string | null = null;
  let revisionTo = order.buyer.email;
  // The seller's own details are incomplete: no revision, the order waits on a hold (issue.ts).
  let sellerIncomplete = false;
  const due = effectiveDueDate({ dueAt: order.dueAt, createdAt: order.createdAt, payableSince: order.payableSince, legacyValidUntil: order.sourcingRequest?.validUntilAt ?? null }, paymentTermDays());
  if (docs.proforma && (changedDetails || amountChanged) && !heldNow) {
    const why = `${opts.actor.kind === 'BUYER' ? 'Billing / delivery details updated by the buyer' : `Billing / delivery details updated by staff (${opts.actor.email})`}${amountChanged ? ` — VAT now ${dec.treatment}, total ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)})` : ''}.`;
    const re = await reissueProforma(order.id, why, { actorId: opts.actor.id });
    if (re.ok) {
      revision = re.document.number;
      if (emailProformaRevision() && !review && !order.holdReason) {
        const att = await documentAttachment(re.document);
        // To the accounts-payable address just saved, always a copy to the account (a proforma mail: the order changed).
        const mail = await mailOrderDocument({
          doc: re.document,
          order: { invoiceEmail: d.billing.invoiceEmail || null, billingAddress: billing, buyer: order.buyer },
          subject: `Updated proforma invoice ${re.document.number} — order ${order.orderNumber}`,
          html: mailLayout({
            heading: `Updated proforma ${re.document.number}`,
            body: [
              `The billing / delivery details of order <strong>${order.orderNumber}</strong> were updated${opts.actor.kind === 'STAFF' ? ' by our team' : ''}, so proforma <strong>${escapeHtml(docs.proforma.number)}</strong> is replaced by <strong>${escapeHtml(re.document.number)}</strong>${att.attachment ? ' (attached)' : ''}.`,
              amountChanged
                ? `The amount changed: <strong>${escapeHtml(formatPrice(newTotal, order.currency))}</strong> (was ${escapeHtml(formatPrice(order.totalCents, order.currency))}), because the VAT follows the billing / delivery details.`
                : 'The amount is unchanged.',
              `Please quote <strong>${escapeHtml(re.document.number)}</strong> as the transfer reference and pay by <strong>${escapeHtml(fmtDueDate(due))}</strong>.`,
            ],
            cta: { href: `${siteBase()}/app/orders/${order.orderNumber}/payment`, label: 'Go to the payment page' },
          }),
          attachment: att.attachment,
          context: 'orders:proforma-revision',
          alwaysCopyAccount: true,
        });
        revisionMail = mail.emailed ? 'sent' : 'failed';
        revisionError = mail.error;
        revisionTo = recipientsLabel(mail);
      } else {
        revisionMail = 'off';
      }
    } else {
      sellerIncomplete = re.code === 'SELLER_INCOMPLETE';
      if (!sellerIncomplete) await logError('orders:proforma-revision', new Error(re.message));
      revisionError = re.message;
    }
  }
  await notifyAdmins(
    `Order ${order.orderNumber}: ${opts.actor.kind === 'BUYER' ? 'buyer' : 'staff'} ${orderDetailsProblems(before, { vatIdRule: vatIdRule() }).length ? 'added' : 'updated'} billing & delivery details`,
    `${d.billing.legalName} · ship to ${d.delivery.city}, ${d.delivery.country}${amountChanged ? ` · total now ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)})` : ''}${revision ? ` · proforma ${revision}` : ''}${review ? ' · COMPLIANCE HOLD' : ''}${addressReview ? (isQuote ? ' · ADDRESS REVIEW (re-quote freight / Incoterm / place)' : ' · ADDRESS REVIEW (re-price & approve)') : ''}`,
    `/admin/orders/${order.id}`,
  );
  await audit(opts.actor.kind === 'BUYER' ? 'order.details.buyer' : 'order.details.staff', order.orderNumber, `${d.billing.legalName} / ${d.delivery.country}${amountChanged ? ` · total ${order.totalCents}→${newTotal}` : ''}${revision ? ` · ${revision}` : ''} by ${opts.actor.email}`);

  const you = opts.actor.kind === 'BUYER';
  const parts = ['Details saved.'];
  if (amountChanged) parts.push(`The VAT follows ${you ? 'your' : 'the'} details: the total is now ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)}).`);
  if (revision) parts.push(`Proforma ${revision} replaces the previous one${revisionMail === 'sent' ? (you ? ' — we emailed it to you' : ` — emailed to ${revisionTo}`) : ''}. Use ${revision} as the transfer reference.`);
  if (review) parts.push(`${review.reason}${you ? ' Please wait for our email before paying.' : ' The order is on compliance hold.'}`);
  if (addressReview) {
    parts.push(isQuote
      ? `The destination of the accepted offer changed (${pricedFor} → ${nextShip}): the order is on hold — re-quote the freight, Incoterm and place (cancel the order and send a new offer), or approve the change under Pricing, VAT & holds if they still apply. No proforma revision is issued until then.`
      : `The destination changed (${prevShip} → ${nextShip}): the order is on hold until shipping and VAT are re-priced for it — “Re-price for the new address & approve” under Pricing, VAT & holds.`);
  }
  if (heldNow && docs.proforma && (changedDetails || amountChanged)) parts.push(you ? 'We email you the updated proforma as soon as you can pay.' : 'The updated proforma is issued and emailed when the hold is released.');
  if (sellerIncomplete) {
    if (you) parts.push('We email you the updated proforma (payment request) as soon as it is ready — nothing is due until then.');
    else return { revision, warning: `${parts.join(' ')} ${revisionError}` };
    return { revision, notice: parts.join(' ') };
  }
  if (revisionMail === 'failed') return { revision, warning: `${parts.join(' ')} The email with the new proforma to ${revisionTo} could not be delivered (${revisionError})${you ? '; download it below' : ''}.` };
  if (revisionError && !revision) return { revision, warning: `${parts.join(' ')} The proforma could not be updated right now (${revisionError}); ${you ? 'our team has been notified' : 'retry with “Re-issue proforma”'}.` };
  return { revision, notice: parts.join(' ') };
}
