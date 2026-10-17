import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { formatPrice } from '@/lib/utils';
import { audit, logError, notifyAdmins } from '@/lib/observability';
import { documentAttachment, getOrderDocuments, markDocumentSent, reissueProforma } from '@/lib/documents/issue';
import type { VatLineInput } from '@/lib/tax/determine';
import { decideVatForDetails } from '@/lib/quotes/engine';
import { addHold, evaluateAddressChange, hasPrePaymentHold, recordAddressChange, type AddressChangeVerdict } from '@/lib/checkout/holds';
import { addressCountry } from '@/lib/tax/order';
import { emailProformaRevision, paymentTermDays, vatIdRule } from '@/lib/quotes/policy';
import { mailLayout, siteBase } from '@/lib/quotes/mail';
import { billingAddressJson, detailsDiffer, orderDetailsProblems, shippingAddressJson, type DetailsFieldErrors, type OrderDetails } from './details';
import { effectiveDueDate, fmtDueDate } from './payment-due';

/**
 * Save the billing + delivery details of an UNPAID order (buyer on the payment
 * page, or staff on the order page). Server-internal: the caller checks who
 * may do this. Re-checks the country policy and, for orders priced by the VAT
 * rules, the VAT; when anything printed on the proforma changes a new proforma
 * revision replaces the old one and is emailed to the buyer.
 *
 * One address rule for every write path (s2a, A12 — lib/checkout/holds.ts):
 *  - every change is kept old → new (AddressChange), BLOCK countries are refused,
 *    REVIEW countries put the order on a COMPLIANCE pre-payment hold (openHolds);
 *  - a CHECKOUT order's delivery country can not be switched by the buyer while
 *    paying (it changes the zone shipping and the VAT); staff may switch it, which
 *    puts the order on ADDRESS_REVIEW until "Re-price & approve" (zone shipping +
 *    VAT for the new destination);
 *  - a QUOTE order keeps the offer's goods + freight and its VAT follows the new
 *    details at once (s2b).
 * While a pre-payment hold is open no proforma revision is issued: the release
 * of the last hold issues and emails it (lib/checkout/notify.ts sendHoldReleased).
 */

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
      sourcingRequest: { select: { id: true, validUntilAt: true } },
    },
  });
  if (!order) return { error: 'Order not found.' };
  if (order.status !== 'PENDING_PAYMENT') {
    return { error: order.status === 'CANCELED' ? 'This order is canceled.' : 'The order is already paid — the billing details are on its invoice; contact support to change the delivery address.' };
  }
  if (order.paymentVerificationStatus === 'AWAITING_VERIFICATION') {
    return { error: opts.actor.kind === 'BUYER' ? 'Your payment receipt is being verified, so the details are locked. Contact support if something must change.' : 'A payment receipt is waiting for verification — verify or reject it first.' };
  }

  const prevShip = addressCountry(order.shippingAddress);
  const nextShip = d.delivery.country;
  const countryChanged = !!prevShip && prevShip !== nextShip;
  let verdict: Extract<AddressChangeVerdict, { ok: true }>;
  if (!order.sourcingRequestId) {
    if (countryChanged && opts.actor.kind === 'BUYER') {
      return {
        error: 'The delivery country cannot be changed while paying: it changes the shipping and VAT of this order. Nothing was saved — contact us to change the destination.',
        fieldErrors: { d_country: `stays ${prevShip} for this order` },
      };
    }
    const v = await evaluateAddressChange(order, nextShip, opts.actor.kind);
    if (!v.ok) return { error: v.message, fieldErrors: { d_country: 'not allowed' } };
    verdict = v;
  } else {
    verdict = {
      ok: true,
      hold: null,
      reviewStatus: 'NONE',
      note: countryChanged
        ? `Destination changed ${prevShip} → ${nextShip} by ${opts.actor.kind === 'BUYER' ? 'the buyer' : 'staff'} before payment: the offer's goods and freight stand, the VAT follows the new details.`
        : 'Billing / delivery details updated before payment.',
      countryChanged,
    };
  }
  // Checkout order moved to another country by staff: shipping + VAT are re-priced
  // on approval (holds.ts approveAddressChange), not here.
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
  const enginePriced = !addressReview && !!order.vatTreatment && order.vatTreatment !== 'LEGACY_UNSPECIFIED' && order.vatRateBp != null;
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
  const due = effectiveDueDate({ dueAt: order.dueAt, createdAt: order.createdAt, payableSince: order.payableSince, legacyValidUntil: order.sourcingRequest?.validUntilAt ?? null }, paymentTermDays());
  if (docs.proforma && (changedDetails || amountChanged) && !heldNow) {
    const why = `${opts.actor.kind === 'BUYER' ? 'Billing / delivery details updated by the buyer' : `Billing / delivery details updated by staff (${opts.actor.email})`}${amountChanged ? ` — VAT now ${dec.treatment}, total ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)})` : ''}.`;
    const re = await reissueProforma(order.id, why, { actorId: opts.actor.id });
    if (re.ok) {
      revision = re.document.number;
      if (emailProformaRevision() && !review && !order.holdReason) {
        const att = await documentAttachment(re.document);
        const sent = await trySendEmail({
          to: order.buyer.email,
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
          attachments: att.attachment ? [att.attachment] : [],
        }, 'orders:proforma-revision');
        revisionMail = sent.ok ? 'sent' : 'failed';
        revisionError = sent.ok ? null : sent.error;
        if (sent.ok) await markDocumentSent(re.document.id);
      } else {
        revisionMail = 'off';
      }
    } else {
      await logError('orders:proforma-revision', new Error(re.message));
      revisionError = re.message;
    }
  }
  await notifyAdmins(
    `Order ${order.orderNumber}: ${opts.actor.kind === 'BUYER' ? 'buyer' : 'staff'} ${orderDetailsProblems(before, { vatIdRule: vatIdRule() }).length ? 'added' : 'updated'} billing & delivery details`,
    `${d.billing.legalName} · ship to ${d.delivery.city}, ${d.delivery.country}${amountChanged ? ` · total now ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)})` : ''}${revision ? ` · proforma ${revision}` : ''}${review ? ' · COMPLIANCE HOLD' : ''}${addressReview ? ' · ADDRESS REVIEW (re-price & approve)' : ''}`,
    `/admin/orders/${order.id}`,
  );
  await audit(opts.actor.kind === 'BUYER' ? 'order.details.buyer' : 'order.details.staff', order.orderNumber, `${d.billing.legalName} / ${d.delivery.country}${amountChanged ? ` · total ${order.totalCents}→${newTotal}` : ''}${revision ? ` · ${revision}` : ''} by ${opts.actor.email}`);

  const you = opts.actor.kind === 'BUYER';
  const parts = ['Details saved.'];
  if (amountChanged) parts.push(`The VAT follows ${you ? 'your' : 'the'} details: the total is now ${formatPrice(newTotal, order.currency)} (was ${formatPrice(order.totalCents, order.currency)}).`);
  if (revision) parts.push(`Proforma ${revision} replaces the previous one${revisionMail === 'sent' ? (you ? ' — we emailed it to you' : ` — emailed to ${order.buyer.email}`) : ''}. Use ${revision} as the transfer reference.`);
  if (review) parts.push(`${review.reason}${you ? ' Please wait for our email before paying.' : ' The order is on compliance hold.'}`);
  if (addressReview) parts.push(`The destination changed (${prevShip} → ${nextShip}): the order is on hold until shipping and VAT are re-priced for it — “Re-price for the new address & approve” under Pricing, VAT & holds.`);
  if (heldNow && docs.proforma && (changedDetails || amountChanged)) parts.push(you ? 'We email you the updated proforma as soon as you can pay.' : 'The updated proforma is issued and emailed when the hold is released.');
  if (revisionMail === 'failed') return { revision, warning: `${parts.join(' ')} The email with the new proforma to ${order.buyer.email} could not be delivered (${revisionError})${you ? '; download it below' : ''}.` };
  if (revisionError && !revision) return { revision, warning: `${parts.join(' ')} The proforma could not be updated right now (${revisionError}); ${you ? 'our team has been notified' : 'retry with “Re-issue proforma”'}.` };
  return { revision, notice: parts.join(' ') };
}
