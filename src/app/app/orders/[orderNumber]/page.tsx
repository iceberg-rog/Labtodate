import Link from 'next/link';
import { documentHref } from '@/lib/documents';
import { notFound } from 'next/navigation';
import { Package, ChevronRight, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { shippingAddressIsComplete } from '@/lib/orders/display';
import { orderFulfilmentView } from '@/lib/fulfilment/view';
import { NextSteps } from '@/components/orders/NextSteps';
import { BuyerRefunds, BuyerReturns, BuyerShipments } from '@/components/orders/BuyerFulfilment';
import { buyerSetShippingAddress } from './payment/actions';
import { getOrderDocuments } from '@/lib/documents/issue';
import { OrderDocumentsPanel } from '@/components/documents/OrderDocumentsPanel';
import { buyerHoldMessages, hasPrePaymentHold } from '@/lib/checkout/holds';
import { countryOptions } from '@/lib/compliance/country';
import { vatTreatmentWithRate } from '@/lib/tax/determine';
import { ensureSettingsLoaded } from '@/lib/settings';
import { addressLines, orderDetailsProblems } from '@/lib/orders/details';
import { effectiveDueDate, fmtDueDate } from '@/lib/orders/payment-due';
import { buyerCanCancelUnpaid, cancelReasons, paymentTermDays, vatIdRule } from '@/lib/quotes/policy';
import { CancelOrderButton } from '@/components/orders/CancelOrderButton';
import { buyerCancelExplanation } from '@/lib/orders/cancel-reason';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'accent' | 'secondary'> = {
  PENDING_PAYMENT: 'warning',
  PAID: 'accent',
  PROCESSING: 'accent',
  SHIPPED: 'success',
  DELIVERED: 'success',
  CANCELED: 'secondary',
  REFUNDED: 'secondary',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Pending payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELED: 'Canceled',
  REFUNDED: 'Refunded',
};

const STEPS = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;

/** Address as separate parts — each rendered in its own <bdi> so a right-to-left
 *  part (e.g. Persian) can not reorder the postal code around it. */
function addrParts(a: unknown): string[] {
  if (!a || typeof a !== 'object') return [];
  const o = a as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? [o.name.trim()] : [];
  const phone = typeof o.phone === 'string' && o.phone.trim() ? [o.phone.trim()] : [];
  return [...name, ...addressLines(a), ...phone];
}

function AddrLine({ raw }: { raw: unknown }) {
  const parts = addrParts(raw);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>{i > 0 && ', '}<bdi>{p}</bdi></span>
      ))}
    </>
  );
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ addr?: string; flash?: string }>;
}) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}` });
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { orderNumber: orderNumber },
    include: {
      items: { include: { product: { select: { slug: true, illustration: true } } } },
      // Refunds as they really are: approved (to be transferred) or sent.
      refunds: { orderBy: { createdAt: 'asc' }, select: { id: true, amountCents: true, currency: true, status: true, method: true, executedAt: true, createdAt: true, creditNote: { select: { number: true } } } },
      payments: { select: { amountCents: true } },
    },
  });
  if (!order || order.buyerId !== session.user.id) notFound();
  const refundsOpen = order.refunds.filter((r) => r.status === 'REQUESTED');
  // The status chip tells the money truth: a refund approved but not sent yet
  // is "Refund in progress", a part refund is "Partly refunded".
  // (The money state counts only money actually sent — lib/finance/refunds.ts — so a canceled
  // order whose refund is approved reads “Canceled · refund in progress”.)
  const chipLabel = refundsOpen.length
    ? order.status === 'REFUNDED' ? 'Refund in progress' : `${STATUS_LABEL[order.status]} · refund in progress`
    : order.financialStatus === 'PARTIALLY_REFUNDED' && order.status !== 'REFUNDED'
      ? `${STATUS_LABEL[order.status]} · partly refunded`
      : STATUS_LABEL[order.status];

  const fv = await orderFulfilmentView(order.id);
  if (!fv) notFound();
  const FLASH: Record<string, string> = {
    received: 'Thanks — your order is recorded as received. If anything is wrong with it, report it under “Problems & returns”.',
    'rma-sent': 'Your request was sent — we emailed you a confirmation. We review it and reply by email; please do not send anything back before our approval.',
    'rma-sent-nomail': 'Your request was sent. We could not email you a confirmation right now — this page shows its status. Please do not send anything back before our approval.',
    canceled: 'Your order is canceled — nothing is due. We emailed you a confirmation.',
    'canceled-nomail': 'Your order is canceled — nothing is due. We could not email you a confirmation right now — this page is your confirmation.',
  };
  const flash = FLASH[sp.flash ?? ''] ?? null;
  // Paid but no shippable address (e.g. a proforma order): the buyer can add it
  // here until the order ships, so it never gets stuck.
  const needsAddress =
    (order.status === 'PAID' || order.status === 'PROCESSING') && fv.shipments.length === 0 && !shippingAddressIsComplete(order.shippingAddress);
  const ship = (order.shippingAddress ?? null) as { name?: string; phone?: string; address?: Record<string, string | null> } | null;
  // A quote order canceled because the quote was declined/closed: say so, or
  // the page reads as a bare "Canceled" with no reason.
  const endedQuote =
    order.status === 'CANCELED' && order.sourcingRequestId
      ? await prisma.sourcingRequest.findFirst({
          where: { id: order.sourcingRequestId, status: { in: ['DECLINED', 'CLOSED'] } },
          select: { id: true, status: true, lostReason: true, lostNote: true },
        })
      : null;

  const docs = await getOrderDocuments(order.id);
  // Pre-payment holds (shipping / VAT / compliance / address): nothing is due yet.
  const held = order.status === 'PENDING_PAYMENT' && hasPrePaymentHold(order);
  const holdMsgs = held || order.openHolds.length ? await buyerHoldMessages(order) : [];
  const shippingPending = order.openHolds.includes('SHIPPING_PENDING');
  const vatPending = order.vatTreatment === 'REVIEW_REQUIRED';
  const countries = needsAddress ? await countryOptions() : [];
  const ADDR_MSG: Record<string, string> = {
    missing: 'Please fill in recipient name, phone, address line 1, city, postal code and the country.',
    closed: 'This order can no longer be re-addressed here — contact support if the address needs to change.',
    blocked: 'We cannot ship to that country. Please choose another delivery address or contact us.',
    never: 'The delivery address of a paid order cannot be changed online. Please contact us.',
    samecountry: 'After payment the address can only change within the same country. For another country, please contact us.',
  };
  // ONE due date (A25); an order that was on hold counts from when it became payable.
  const due = effectiveDueDate({ dueAt: order.dueAt, createdAt: order.createdAt, payableSince: order.payableSince }, paymentTermDays());
  const detailsMissing = orderDetailsProblems(order, { vatIdRule: vatIdRule() });
  const termsRequested = order.paymentVerificationStatus === 'TERMS_REQUESTED';
  const onTerms = order.paymentMethodManual === 'INVOICE' && ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(order.financialStatus);
  // Any unpaid order (quote or checkout) until a receipt is sent (BUYER_CAN_CANCEL_UNPAID_ORDER).
  const canCancel = order.status === 'PENDING_PAYMENT' && !order.paymentSubmittedAt && buyerCanCancelUnpaid();

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Link href="/app/orders" className="hover:text-foreground">Orders</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-mono">{order.orderNumber}</span>
      </nav>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Order {order.orderNumber}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Placed {new Date(order.createdAt).toLocaleDateString('en-US', { dateStyle: 'long' })}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {order.sourcingRequestId && (
            <a
              href={`/app/quotes/${order.sourcingRequestId}?history=1`}
              className="text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline"
            >
              Quote history
            </a>
          )}
          {/* Issued documents only (stored PDFs) — never a link to an invoice that does not exist. */}
          {docs.invoice ? (
            <a
              href={documentHref('invoice', order.orderNumber, 'pdf')}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3.5 py-1.5 text-sm font-semibold hover:bg-primary/90 shadow-sm"
            >
              <FileText className="h-4 w-4" /> Invoice PDF
            </a>
          ) : order.status === 'PENDING_PAYMENT' && !held ? (
            <a
              href={documentHref('proforma', order.orderNumber, 'pdf')}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary text-primary px-3.5 py-1.5 text-sm font-semibold hover:bg-primary/5"
            >
              <FileText className="h-4 w-4" /> Proforma invoice PDF
            </a>
          ) : null}
          <Badge variant={STATUS_VARIANT[order.status]}>{chipLabel}</Badge>
        </div>
      </div>

      {flash && (
        <div role="status" className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4 text-sm text-emerald-900 dark:text-emerald-300 font-semibold">{flash}</div>
      )}

      <NextSteps steps={fv.nextSteps.buyer} audience="buyer" />

      <OrderDocumentsPanel order={{ id: order.id, orderNumber: order.orderNumber, status: order.status, holdReason: order.holdReason }} audience="buyer" />

      {endedQuote && (
        <div className="rounded-2xl border border-border bg-muted p-4 text-sm text-muted-foreground">
          {(() => {
            const why = buyerCancelExplanation({ quote: endedQuote, adminNotes: order.adminNotes, proformaVoidReason: docs.proformaHistory.at(-1)?.voidReason ?? null });
            return <><strong className="text-foreground">{why.title}</strong>{why.detail && <span className="[overflow-wrap:anywhere]" dir="auto"> {why.detail}</span>}{' '}</>;
          })()}
          <a href={`/app/quotes/${endedQuote.id}`} className="font-semibold text-primary hover:underline">
            View the quote
          </a>
        </div>
      )}

      {sp.addr === 'saved' && (
        <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4 text-sm text-emerald-900 dark:text-emerald-300 font-semibold">
          Shipping address saved ✓ — we&apos;ll use it to dispatch your order.
        </div>
      )}
      {sp.addr === 'review' && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-300 font-semibold">
          Address saved. The destination changed, so our team re-checks VAT, shipping and export rules before the order continues.
        </div>
      )}
      {sp.addr && ADDR_MSG[sp.addr] && (
        <div className="rounded-2xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-900 dark:text-red-300" role="alert">
          {ADDR_MSG[sp.addr]}
        </div>
      )}
      {holdMsgs.length > 0 && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-300 space-y-1.5" data-testid="order-holds">
          <p className="font-bold">{held ? 'We confirm the final total before you pay — nothing is due yet' : 'Your order is being reviewed'}</p>
          {holdMsgs.map((h) => (
            <p key={h.code}><span className="font-semibold">{h.title}:</span> {h.message}</p>
          ))}
          {held && <p className="text-xs">Please do not transfer money for this order until you receive the final total by email.</p>}
        </div>
      )}

      {needsAddress && (
        <form
          action={buyerSetShippingAddress}
          className="rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-5 space-y-3"
        >
          <input type="hidden" name="orderNumber" value={order.orderNumber} />
          <div>
            <p className="font-bold text-amber-900 dark:text-amber-300">Where should we ship this?</p>
            <p className="text-sm text-amber-900/90 dark:text-amber-300/90 mt-0.5">
              Your payment is in — add the delivery address so we can dispatch the order.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <AddrInput label="Recipient name" name="addr_name" defaultValue={ship?.name ?? session.user.name ?? ''} />
            <AddrInput label="Phone" name="addr_phone" defaultValue={ship?.phone ?? ''} />
            <AddrInput label="Address line 1" name="addr_line1" defaultValue={String(ship?.address?.line1 ?? '')} />
            <AddrInput label="Address line 2 (optional)" name="addr_line2" defaultValue={String(ship?.address?.line2 ?? '')} optional />
            <AddrInput label="City" name="addr_city" defaultValue={String(ship?.address?.city ?? '')} />
            <AddrInput label="Postal code" name="addr_postal" defaultValue={String(ship?.address?.postal_code ?? '')} />
            <AddrInput label="State / region (optional)" name="addr_state" defaultValue={String(ship?.address?.state ?? '')} optional />
            <label className="block">
              <span className="block text-xs font-semibold mb-1">Country</span>
              <select name="addr_country" required defaultValue={countries.some((c) => c.code === ship?.address?.country) ? String(ship?.address?.country) : ''} className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm">
                <option value="">Choose…</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}{c.review ? ' — reviewed first' : ''}</option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="rounded-full bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold px-4 py-2">
            Save shipping address
          </button>
        </form>
      )}

      {order.status === 'PENDING_PAYMENT' && !held && (
        // [overflow-wrap:anywhere]: the address and rejection reason are
        // buyer/admin text and may hold long unbroken words.
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-300 [overflow-wrap:anywhere]">
          <p className="font-bold">
            {order.paymentVerificationStatus === 'AWAITING_VERIFICATION'
              ? 'Your payment proof is being reviewed'
              : order.paymentVerificationStatus === 'REJECTED'
              ? 'Your payment proof needs attention'
              : termsRequested
              ? 'You asked to pay on invoice'
              : order.holdReason === 'COMPLIANCE'
              ? 'Please do not pay yet'
              : `Awaiting payment — due ${fmtDueDate(due)}`}
          </p>
          <p className="mt-1">
            {order.paymentVerificationStatus === 'AWAITING_VERIFICATION' ? (
              <>We&apos;ll email you when it&apos;s verified.</>
            ) : order.paymentVerificationStatus === 'REJECTED' ? (
              <>
                {order.paymentRejectionReason || 'Please upload a corrected receipt.'}{' '}
              </>
            ) : termsRequested ? (
              <>Our team reviews the request and emails you. Nothing is due until then.</>
            ) : order.holdReason === 'COMPLIANCE' ? (
              <>Our team checks the export rules for the delivery country. We email you the payment details as soon as you can pay.</>
            ) : (
              <>
                {order.stripeSessionId
                  ? 'Your card payment is not confirmed yet. If you closed the card page, the order is canceled automatically when the payment session expires.'
                  : <>Pay {formatPrice(order.totalCents, order.currency)} by bank transfer by <strong>{fmtDueDate(due)}</strong> with the details on the payment page (also on your proforma) and upload the receipt — we verify it and arrange shipping.</>}
                {!order.stripeSessionId && detailsMissing.length > 0 && <> First add your billing and delivery details ({detailsMissing.join(', ')}).</>}
              </>
            )}
          </p>
          <Link
            href={`/app/orders/${order.orderNumber}/payment`}
            className="inline-flex items-center gap-1.5 mt-3 h-9 px-4 rounded-full bg-amber-700 text-white text-xs font-bold hover:bg-amber-800"
          >
            {order.paymentVerificationStatus === 'AWAITING_VERIFICATION'
              ? 'View payment status'
              : order.paymentVerificationStatus === 'REJECTED'
              ? 'Resubmit receipt'
              : 'Pay now / upload receipt'}
          </Link>
          {addrParts(order.shippingAddress).length > 0 && (
            <p className="mt-3 text-xs">
              <span className="font-bold uppercase tracking-wider">Shipping to:</span> <AddrLine raw={order.shippingAddress} />
            </p>
          )}
          {canCancel && (
            <div className="mt-3 flex flex-wrap gap-2">
              <CancelOrderButton orderNumber={order.orderNumber} reasons={cancelReasons()} compact kind={order.sourcingRequestId ? 'quote' : 'checkout'} />
            </div>
          )}
        </div>
      )}

      {onTerms && (
        <div className="rounded-2xl border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 p-4 text-sm text-sky-900 dark:text-sky-300">
          <p className="font-bold">Approved on invoice terms{docs.invoice ? ` — invoice ${docs.invoice.number}` : ''}</p>
          <p className="mt-1">
            {order.financialStatus === 'PARTIALLY_PAID' ? `Received ${formatPrice(order.amountPaidCents, order.currency)} so far. ` : ''}
            {docs.invoice?.dueDate ? <>Pay {formatPrice(order.totalCents - order.amountPaidCents, order.currency)} by <strong>{fmtDueDate(docs.invoice.dueDate)}</strong>, quoting {docs.invoice.number}.</> : 'The invoice states the due date.'}
          </p>
        </div>
      )}

      {!['CANCELED', 'REFUNDED', 'PENDING_PAYMENT'].includes(order.status) && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-5">
            Fulfillment
          </p>
          <div className="flex items-center">
            {STEPS.map((s, i) => {
              const curIdx = STEPS.indexOf(order.status as (typeof STEPS)[number]);
              const reached = curIdx >= i;
              return (
                <div key={s} className="flex-1 flex items-center last:flex-none">
                  <div className="flex flex-col items-center">
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                        reached ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {i + 1}
                    </div>
                    <span className={`mt-2 text-[11px] font-semibold ${reached ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {STATUS_LABEL[s]}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-2 ${curIdx > i ? 'bg-primary' : 'bg-border'}`} />
                  )}
                </div>
              );
            })}
          </div>

          {order.status === 'DELIVERED' && order.deliveredAt && (
            <div className="mt-6 pt-5 border-t text-sm text-emerald-800 dark:text-emerald-300">
              <p className="font-semibold">
                ✓ Delivered {new Date(order.deliveredAt).toLocaleDateString('en-US', { dateStyle: 'long' })}
              </p>
            </div>
          )}
          {addrParts(order.shippingAddress).length > 0 && (
            <div className="mt-5 pt-5 border-t text-sm">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Shipping to</p>
              <p className="[overflow-wrap:anywhere]"><AddrLine raw={order.shippingAddress} /></p>
            </div>
          )}
        </div>
      )}

      <BuyerShipments v={fv} />
      <BuyerRefunds v={fv} />
      <BuyerReturns v={fv} />

      <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {order.items.map((it) => (
          <div key={it.id} className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <Package className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
              {it.product ? (
                <Link href={`/marketplace/${it.product.slug}`} className="font-semibold hover:text-primary">
                  {it.titleSnapshot}
                </Link>
              ) : (
                <span className="font-semibold">{it.titleSnapshot}</span>
              )}
              {(it.brandSnapshot || it.conditionSnapshot) && (
                <p className="text-xs text-muted-foreground">{[it.brandSnapshot, it.conditionSnapshot].filter(Boolean).join(' · ')}</p>
              )}
              {/* The warranty this unit was sold under (frozen on the order line; also on the invoice). */}
              {it.warrantySnapshot && (
                <p className="text-xs text-muted-foreground" data-testid="order-line-warranty">Warranty: {it.warrantySnapshot}</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-sm font-bold tabular-nums">{formatPrice(it.priceCentsSnapshot * it.quantity, order.currency)}</p>
              <p className="text-xs text-muted-foreground tabular-nums">{it.quantity} × {formatPrice(it.priceCentsSnapshot, order.currency)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 space-y-2">
        <Row label="Subtotal (excl. VAT)" value={formatPrice(order.subtotalCents, order.currency)} />
        <Row label="Shipping" value={shippingPending ? 'to be confirmed' : order.shippingCents ? formatPrice(order.shippingCents, order.currency) : 'free'} />
        <Row
          label={`VAT${order.vatTreatment && !vatPending && order.vatTreatment !== 'LEGACY_UNSPECIFIED' ? ` — ${vatTreatmentWithRate(order.vatTreatment, order.vatRateBp)}` : ''}`}
          value={vatPending ? 'to be confirmed' : formatPrice(order.taxCents, order.currency)}
        />
        <div className="pt-2 border-t mt-2">
          <Row label={shippingPending || vatPending ? 'Total so far' : 'Total'} value={formatPrice(order.totalCents, order.currency)} bold />
        </div>
        {/* Refunds (approved / sent / completed, with their credit notes) are their own section: <BuyerRefunds>. */}
        {order.poNumber && <p className="text-xs text-muted-foreground pt-1">Your PO number: {order.poNumber}</p>}
      </div>
    </div>
  );
}

function AddrInput({
  label,
  name,
  defaultValue,
  optional,
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue: string;
  optional?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue}
        required={!optional}
        maxLength={maxLength}
        className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
      />
    </label>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? 'text-base font-bold' : 'text-sm'}`}>
      <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
