import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formatPrice } from '@/lib/utils';
import { hasPrePaymentHold } from '@/lib/checkout/holds';
import { orderDetailsProblems } from '@/lib/orders/details';
import { buyerCanCancelUnpaid, vatIdRule } from '@/lib/quotes/policy';
import {
  buildTrackingUrl,
  findCarrier,
  OPEN_RETURN_STATUSES,
  orderNextSteps,
  refundCapacity,
  REFUND_STATUS_LABEL,
  remainingToShip,
  RETURN_STATUS_LABEL,
  RETURN_TYPE_LABEL,
  shipProgress,
  trackingRequired,
} from './rules';
import { carriers, insureByDefault, refundReasons, refundShippedNeedsJustification, requireTrackingToShip, restockOnPaidCancel, staffCancelReasons } from './policy';
import { orderReservedStock } from '@/lib/orders/checkout-tx';
import { quoteOrderTookStock } from '@/lib/quotes/stock';
import { orderShipBlockers } from './shipments';
import { loadMoney, METHOD_LABEL, type RefundMethod } from '@/lib/finance/refunds';
import { returnContext, returnInstructionsDraft } from './returns';

/**
 * Everything the admin and buyer order pages show about shipping, money back
 * and returns — one loader, so both sides see the same facts. Private files go
 * through /api/order-files (auth-checked); packing slips through
 * /api/shipments/<id>/packing-slip (staff).
 */

export const fileHref = (key: string) => `/api/order-files/${key}`;

export async function orderFulfilmentView(orderId: string) {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, status: true, financialStatus: true, currency: true, totalCents: true, amountPaidCents: true,
      paymentSubmittedAt: true, paymentVerificationStatus: true, openHolds: true, holdReason: true, sourcingRequestId: true,
      billingAddress: true, shippingAddress: true, customerType: true, stripePaymentIntentId: true, shippedAt: true, deliveredAt: true,
      items: { select: { id: true, titleSnapshot: true, brandSnapshot: true, quantity: true, priceCentsSnapshot: true, lineType: true } },
      shipments: { orderBy: { seq: 'asc' }, include: { items: { select: { orderItemId: true, qty: true } } } },
      refunds: { orderBy: { createdAt: 'asc' }, include: { creditNote: { select: { number: true } } } },
      returnRequests: { orderBy: { createdAt: 'desc' }, include: { items: { select: { orderItemId: true, qty: true } }, refunds: { select: { id: true } } } },
      documents: { where: { kind: { in: ['INVOICE', 'CREDIT_NOTE'] } }, select: { kind: true, number: true } },
    },
  });
  if (!o) return null;
  const list = carriers();
  const title = (id: string) => o.items.find((i) => i.id === id)?.titleSnapshot ?? 'item';
  const goods = o.items.filter((i) => i.lineType === 'GOODS' || !i.lineType);
  const shippedLines = o.shipments.flatMap((s) => s.items);
  const remaining = remainingToShip(goods, shippedLines);
  const progress = shipProgress(goods, shippedLines);
  const blockers = await orderShipBlockers(o);
  const m = await loadMoney(prisma, o.id);
  const cap = m ? refundCapacity(m.state) : { maxCents: 0, receivableCents: 0, moneyCents: 0 };
  // Stock with a refund / credit: only a unit that never left, at most once per order (A10).
  const tookStock = orderReservedStock(o) || (!!o.sourcingRequestId && (await quoteOrderTookStock(o.id)));
  const alreadyRestocked = o.refunds.some((r) => r.restock) || o.returnRequests.some((r) => r.restockedQty > 0);
  const canRestock = tookStock && !alreadyRestocked && o.shipments.length === 0 && !o.shippedAt && ['PAID', 'PROCESSING', 'REFUNDED'].includes(o.status);
  const rc = await returnContext(o.id);
  const money = (c: number) => formatPrice(c, o.currency);
  const onTermsUnpaid = ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(o.financialStatus) && o.amountPaidCents < o.totalCents;
  const detailsMissing = orderDetailsProblems(o, { vatIdRule: vatIdRule() });
  const invoice = o.documents.find((d) => d.kind === 'INVOICE') ?? null;

  const shipments = o.shipments.map((s) => ({
    id: s.id,
    seq: s.seq,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingLink: s.trackingUrl ?? buildTrackingUrl(findCarrier(list, s.carrier), s.trackingNumber),
    parcels: s.parcels,
    grossKg: s.grossKg,
    insuredLabel: s.insured && s.insuredValueCents ? money(s.insuredValueCents) : null,
    shippedAt: s.shippedAt,
    deliveredAt: s.deliveredAt,
    deliveredBy: s.deliveredBy,
    podHref: s.podKey ? fileHref(s.podKey) : null,
    packingSlipHref: `/api/shipments/${s.id}/packing-slip`,
    emailed: !!s.shippedEmailAt,
    note: s.note,
    items: s.items.map((i) => ({ title: title(i.orderItemId), qty: i.qty })),
  }));

  const refunds = o.refunds.map((r) => ({
    id: r.id,
    amountCents: r.amountCents,
    amountLabel: money(r.amountCents),
    method: r.method,
    methodLabel: METHOD_LABEL[r.method as RefundMethod] ?? r.method.toLowerCase(),
    status: r.status,
    statusLabel: r.status === 'SENT' && r.method === 'STRIPE' ? 'Card refund issued' : REFUND_STATUS_LABEL[r.status] ?? r.status,
    reason: r.reason,
    creditNote: r.creditNote?.number ?? null,
    createdAt: r.createdAt,
    sentAt: r.executedAt,
    bankRef: r.bankRef,
    payeeIban: r.payeeIban,
    proofHref: r.proofKey ? fileHref(r.proofKey) : null,
    confirmedAt: r.confirmedAt,
    justification: r.overrideReason,
    legacy: r.method === 'LEGACY',
  }));

  const returns = o.returnRequests.map((r) => ({
    id: r.id,
    rmaNumber: r.rmaNumber,
    type: r.type,
    typeLabel: RETURN_TYPE_LABEL[r.type] ?? r.type,
    status: r.status,
    statusLabel: RETURN_STATUS_LABEL[r.status] ?? r.status,
    reason: r.reasonCode,
    description: r.description,
    items: r.items.map((i) => ({ title: title(i.orderItemId), qty: i.qty })),
    files: r.attachments.map((k) => ({ href: fileHref(k), isPdf: k.endsWith('.pdf') })),
    openedBy: r.openedBy,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decisionReason: r.decisionReason,
    instructions: r.instructions,
    labelHref: r.labelKey ? fileHref(r.labelKey) : null,
    noReturnNeeded: r.noReturnNeeded,
    returnCarrier: r.returnCarrier,
    returnTracking: r.returnTracking,
    receivedAt: r.receivedAt,
    inspectionGrade: r.inspectionGrade,
    inspectionNote: r.inspectionNote,
    restockedQty: r.restockedQty,
    outcome: r.outcome,
    resolutionNote: r.resolutionNote,
    resolvedAt: r.resolvedAt,
    open: (OPEN_RETURN_STATUSES as readonly string[]).includes(r.status),
    instructionsDraft: r.status === 'REQUESTED' ? returnInstructionsDraft(r.rmaNumber) : null,
    hasRefund: r.refunds.length > 0,
  }));

  const nextInput = {
    status: o.status,
    financialStatus: o.financialStatus,
    onTermsUnpaid,
    prePaymentHold: o.status === 'PENDING_PAYMENT' && hasPrePaymentHold(o),
    paymentVerificationStatus: o.paymentVerificationStatus,
    paymentSubmitted: !!o.paymentSubmittedAt,
    detailsMissing,
    shipBlockers: blockers,
    progress,
    deliveredAt: o.deliveredAt,
    refunds: refunds.filter((r) => r.status === 'REQUESTED' || (r.status === 'SENT' && r.method !== 'STRIPE')).map((r) => ({ status: r.status, amountLabel: r.amountLabel })),
    returns: returns.filter((r) => r.open).map((r) => ({ status: r.status, rmaNumber: r.rmaNumber, noReturnNeeded: r.noReturnNeeded })),
    returnWindowEndsAt: rc?.eligibility.canRequest ? rc.eligibility.windowEndsAt : null,
    returnsOpen: !!rc?.eligibility.canRequest,
    buyerCanCancel: o.status === 'PENDING_PAYMENT' && !o.paymentSubmittedAt && buyerCanCancelUnpaid(),
    invoiceIssued: !!invoice,
  };

  return {
    order: o,
    progress,
    remaining: goods.filter((g) => (remaining[g.id] ?? 0) > 0).map((g) => ({ id: g.id, title: g.titleSnapshot, brand: g.brandSnapshot, left: remaining[g.id], unitCents: g.priceCentsSnapshot })),
    blockers,
    detailsMissing,
    shipments,
    carriers: list.map((c) => ({ name: c.name, needsTracking: trackingRequired(c, requireTrackingToShip()) })),
    insureByDefault: insureByDefault(),
    refunds,
    capacity: cap,
    capacityLabels: { max: money(cap.maxCents), money: money(cap.moneyCents), receivable: money(cap.receivableCents) },
    /** Received / refunded (sent) so far — the refund form's context line. */
    paidLabel: money(m?.state.paidCents ?? 0),
    refundedSentLabel: o.refunds.some((r) => r.status === 'SENT' || r.status === 'CONFIRMED') ? money(o.refunds.filter((r) => r.status === 'SENT' || r.status === 'CONFIRMED').reduce((a, r) => a + r.amountCents, 0)) : null,
    /** A part payment on an unpaid order (no invoice yet): it can be refunded before the order is canceled. */
    partPaidUnpaid: o.status === 'PENDING_PAYMENT' && !invoice && cap.moneyCents > 0,
    restockDefault: canRestock ? restockOnPaidCancel() : null,
    restockHint: 'the unit was not shipped yet — tick when it goes back on sale',
    invoiceNumber: invoice?.number ?? null,
    canCardRefund: !!o.stripePaymentIntentId,
    refundReasons: refundReasons(),
    staffCancelReasons: staffCancelReasons(),
    refundNeedsJustification: refundShippedNeedsJustification() && o.shipments.length > 0,
    restockOnCancel: restockOnPaidCancel(),
    onTermsUnpaid,
    returns,
    returnEligibility: rc?.eligibility ?? null,
    returnReasons: rc?.reasons ?? [],
    shippedUnits: rc?.shipped ?? {},
    photosRequiredFor: rc?.photosFor ?? [],
    returnMaxFiles: rc?.maxFiles ?? 6,
    returnMaxMb: rc?.maxMb ?? 8,
    nextSteps: { buyer: orderNextSteps(nextInput, 'buyer'), staff: orderNextSteps(nextInput, 'staff') },
  };
}

export type OrderFulfilmentView = NonNullable<Awaited<ReturnType<typeof orderFulfilmentView>>>;
