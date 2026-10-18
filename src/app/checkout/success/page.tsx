import Link from 'next/link';
import { documentHref } from '@/lib/documents';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ArrowRight, Clock, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { vatTreatmentWithRate } from '@/lib/tax/determine';
import { buyerHoldMessages, hasPrePaymentHold, sellerDetailsHoldOnly } from '@/lib/checkout/holds';

export const metadata = { title: 'Order received' };
export const dynamic = 'force-dynamic';

/**
 * After checkout. Says exactly what is true for THIS order: paid (card), card
 * payment still being confirmed, payable by bank transfer (proforma), or on
 * hold with nothing due until our team confirms the total.
 */
export default async function CheckoutSuccessPage(props: {
  searchParams: Promise<{ order?: string; session_id?: string; mail?: string }>;
}) {
  const searchParams = await props.searchParams;
  if (!searchParams.order) notFound();
  // Order numbers are not secrets (bank-transfer reference, emails), so the
  // summary is shown only to the buyer who placed the order.
  const session = await requireSession({
    redirectTo: `/checkout/success?order=${encodeURIComponent(searchParams.order)}`,
  });

  const order = await prisma.order.findUnique({
    where: { orderNumber: searchParams.order },
    include: { items: true },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  const isPaid = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status);
  const held = order.status === 'PENDING_PAYMENT' && hasPrePaymentHold(order);
  const paymentReview = order.status === 'PENDING_PAYMENT' && (order.holdReason === 'PAYMENT_REVIEW' || order.openHolds.includes('PAYMENT_REVIEW'));
  const cardPending = order.status === 'PENDING_PAYMENT' && !!order.stripeSessionId && !held && !paymentReview;
  const canceled = order.status === 'CANCELED';
  // Only the seller's payment details are missing (the total is final): the proforma follows.
  const sellerOnly = held && sellerDetailsHoldOnly(order);
  const holdMsgs = held ? await buyerHoldMessages(order) : [];
  const shippingPending = order.openHolds.includes('SHIPPING_PENDING');
  const vatPending = order.vatTreatment === 'REVIEW_REQUIRED';
  const cur = order.currency;

  const title = canceled ? 'Order canceled.' : isPaid ? 'Order placed and paid.' : paymentReview ? 'Payment received — being checked.' : held ? (sellerOnly ? 'Order received — payment details follow.' : 'Order received — total to be confirmed.') : cardPending ? 'Confirming your payment…' : 'Order received.';
  const lead = canceled
    ? 'This order was canceled. No payment is due.'
    : paymentReview
      ? 'We received a card payment that does not match this order exactly. Our team checks it and contacts you — please do not pay again.'
      : isPaid
      ? 'Your payment is confirmed. Your invoice is below and was emailed to you.'
      : held
        ? sellerOnly
          ? 'The items are reserved for you and the total is final. Nothing is due yet: our team is completing the payment details and emails you the proforma invoice as soon as it is ready.'
          : 'The items are reserved for you. Nothing is due yet: our team confirms the open point(s) below and emails you the final total and the payment details.'
        : cardPending
          ? 'Stripe is confirming your card payment. This page shows “paid” once the confirmation arrives — usually within a minute. Refresh to check.'
          : 'Please pay by bank transfer using the details on your proforma (also on the payment page). We dispatch once your payment is received and verified.';

  return (
    <div className="container-px py-16 max-w-2xl mx-auto">
      <div className="text-center">
        <div className={`mx-auto h-16 w-16 rounded-full flex items-center justify-center mb-6 ${held || cardPending || paymentReview ? 'bg-amber-100 dark:bg-amber-950/50' : 'bg-accent/20'}`}>
          {held || cardPending || paymentReview ? <Clock className="h-8 w-8 text-amber-700 dark:text-amber-300" /> : <CheckCircle2 className="h-8 w-8 text-primary" />}
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }} data-testid="success-title">{title}</h1>
        <p className="mt-4 text-muted-foreground text-base sm:text-lg" data-testid="success-lead">{lead}</p>
        {searchParams.mail === '0' && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-300 text-xs px-3 py-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" /> We could not email the confirmation right now — everything is on your order page.
          </p>
        )}
      </div>

      {held && (
        <div className="mt-8 rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200 space-y-1.5" data-testid="success-holds">
          {holdMsgs.map((h) => (
            <p key={h.code}><span className="font-semibold">{h.title}:</span> {h.message}</p>
          ))}
          <p className="text-xs">Please do not transfer money for this order until you receive {sellerOnly ? 'the proforma invoice' : 'the final total'}.</p>
        </div>
      )}

      <div className="mt-8 rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground">Order #</p>
          <p className="font-mono font-bold">{order.orderNumber}</p>
        </div>
        <div className="space-y-3">
          {order.items.map((it) => (
            <div key={it.id} className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                <Package className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">{it.titleSnapshot}</p>
                <p className="text-xs text-muted-foreground">{it.quantity} × {formatPrice(it.priceCentsSnapshot, cur)}{it.brandSnapshot ? ` · ${it.brandSnapshot}` : ''}</p>
              </div>
              <p className="text-sm font-bold tabular-nums">{formatPrice(it.priceCentsSnapshot * it.quantity, cur)}</p>
            </div>
          ))}
        </div>
        <dl className="border-t pt-4 space-y-1.5 text-sm" data-testid="success-totals">
          <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal (excl. VAT)</dt><dd className="tabular-nums">{formatPrice(order.subtotalCents, cur)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Shipping</dt><dd className="tabular-nums">{shippingPending ? 'to be confirmed' : order.shippingCents ? formatPrice(order.shippingCents, cur) : 'free'}</dd></div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">VAT{order.vatTreatment && !vatPending && order.vatTreatment !== 'LEGACY_UNSPECIFIED' ? ` — ${vatTreatmentWithRate(order.vatTreatment, order.vatRateBp)}` : ''}</dt>
            <dd className="tabular-nums">{vatPending ? 'to be confirmed' : formatPrice(order.taxCents, cur)}</dd>
          </div>
          <div className="flex justify-between border-t pt-2 font-bold text-base"><dt>{shippingPending || vatPending ? 'Total so far' : 'Total'}</dt><dd className="tabular-nums">{formatPrice(order.totalCents, cur)}</dd></div>
        </dl>
      </div>

      <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild size="lg" className="rounded-2xl font-semibold">
          <Link href={`/app/orders/${order.orderNumber}`}>
            View order &amp; status <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        {isPaid ? (
          <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
            <a href={documentHref('invoice', order.orderNumber, 'pdf')}>Download invoice (PDF)</a>
          </Button>
        ) : !held && !cardPending && !canceled && !paymentReview ? (
          <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
            <Link href={`/app/orders/${order.orderNumber}/payment`}>Payment details &amp; proforma</Link>
          </Button>
        ) : null}
      </div>
      <p className="mt-4 text-center">
        <Link href="/marketplace" className="text-sm text-muted-foreground hover:text-foreground">
          Continue shopping
        </Link>
      </p>
    </div>
  );
}
