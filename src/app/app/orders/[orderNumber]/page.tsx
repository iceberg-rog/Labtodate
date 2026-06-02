import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Package, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { confirmDelivery, requestReturn } from '@/lib/orders/actions';

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

function fmtAddr(a: unknown): string | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown>) || o;
  const parts = [o.name, ad.line1, ad.line2, ad.postal_code, ad.city, ad.state, ad.country, o.phone]
    .filter((x) => typeof x === 'string' && (x as string).trim());
  return parts.length ? parts.join(', ') : null;
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: { orderNumber: string };
  searchParams: { returned?: string };
}) {
  const session = await requireSession({ redirectTo: `/app/orders/${params.orderNumber}` });

  const order = await prisma.order.findUnique({
    where: { orderNumber: params.orderNumber },
    include: { items: { include: { product: { select: { slug: true, illustration: true } } } } },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  // Persistently reflect an existing return request so the form can't be
  // resubmitted into duplicate tickets (URL param alone wasn't enough).
  const activeReturn = await prisma.supportTicket.findFirst({
    where: {
      submittedById: session.user.id,
      subject: `Return / refund — order ${order.orderNumber}`,
      status: { in: ['OPEN', 'PENDING'] },
    },
    select: { ref: true },
  });
  const returnedRef = searchParams.returned ?? activeReturn?.ref;
  const alreadyRequested = !!activeReturn;

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
        <div className="flex items-center gap-3">
          {order.sourcingRequestId && (
            <a
              href={`/app/quotes/${order.sourcingRequestId}?history=1`}
              className="text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline"
            >
              Quote history
            </a>
          )}
          <a
            href={`/app/orders/${order.orderNumber}/invoice`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            Invoice
          </a>
          <Badge variant={STATUS_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
        </div>
      </div>

      {returnedRef && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-bold">Return request submitted ✓</p>
          <p className="mt-1">
            Reference <span className="font-mono font-semibold">{returnedRef}</span>. We&apos;ve opened a
            tracked support ticket and emailed you — follow it under{' '}
            <Link href="/app/support" className="underline font-semibold">Support</Link>.
          </p>
        </div>
      )}

      {order.status === 'PENDING_PAYMENT' && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-bold">
            {order.paymentVerificationStatus === 'AWAITING_VERIFICATION'
              ? 'Your payment proof is being reviewed'
              : order.paymentVerificationStatus === 'REJECTED'
              ? 'Your payment proof needs attention'
              : 'Awaiting payment'}
          </p>
          <p className="mt-1">
            {order.paymentVerificationStatus === 'AWAITING_VERIFICATION' ? (
              <>We&apos;ll email you when it&apos;s verified — typically within 1 business day.</>
            ) : order.paymentVerificationStatus === 'REJECTED' ? (
              <>
                {order.paymentRejectionReason || 'Please upload a corrected receipt.'}{' '}
              </>
            ) : (
              <>
                Pay by bank transfer and upload the receipt — we&apos;ll verify and arrange shipping.
                Or wait for our team to email you a payment link at{' '}
                <span className="font-semibold">{session.user.email}</span>.
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

          {(order.trackingNumber || order.trackingCarrier) && (
            <div className="mt-6 pt-5 border-t text-sm">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Tracking</p>
              <p className="font-semibold">
                {order.trackingCarrier ?? 'Carrier'} · {order.trackingNumber ?? '—'}
              </p>
            </div>
          )}
          {order.status === 'SHIPPED' && (
            <div className="mt-6 pt-5 border-t">
              <form action={confirmDelivery.bind(null, order.orderNumber)} className="flex items-center justify-between gap-4 flex-wrap">
                <div className="text-sm">
                  <p className="font-bold">Did your package arrive?</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Confirming delivery closes the shipment in our system.
                  </p>
                </div>
                <button
                  type="submit"
                  className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2"
                >
                  Mark as received
                </button>
              </form>
            </div>
          )}
          {order.status === 'DELIVERED' && order.deliveredAt && (
            <div className="mt-6 pt-5 border-t text-sm text-emerald-800">
              <p className="font-semibold">
                ✓ Delivered {new Date(order.deliveredAt).toLocaleDateString('en-US', { dateStyle: 'long' })}
              </p>
            </div>
          )}
          {fmtAddr(order.shippingAddress) && (
            <div className="mt-5 pt-5 border-t text-sm">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Shipping to</p>
              <p>{fmtAddr(order.shippingAddress)}</p>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {order.items.map((it) => (
          <div key={it.id} className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <Package className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              {it.product ? (
                <Link href={`/marketplace/${it.product.slug}`} className="font-semibold hover:text-primary">
                  {it.titleSnapshot}
                </Link>
              ) : (
                <span className="font-semibold">{it.titleSnapshot}</span>
              )}
              {it.brandSnapshot && <p className="text-xs text-muted-foreground">{it.brandSnapshot}</p>}
            </div>
            <div className="text-right">
              <p className="text-sm font-bold tabular-nums">{formatPrice(it.priceCentsSnapshot, order.currency)}</p>
              <p className="text-xs text-muted-foreground">Qty {it.quantity}</p>
            </div>
          </div>
        ))}
      </div>

      {['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status) && !returnedRef && (
        <form
          action={requestReturn.bind(null, order.orderNumber)}
          className="rounded-2xl border border-border bg-card p-5 space-y-3"
        >
          <p className="text-sm font-bold">Request a return / refund</p>
          <textarea
            name="reason"
            rows={3}
            placeholder="Tell us what's wrong or why you'd like to return this…"
            className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="submit"
            className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
          >
            Submit return request
          </button>
          <p className="text-xs text-muted-foreground">Opens a tracked support ticket; we reply by email.</p>
        </form>
      )}

      <div className="rounded-2xl border border-border bg-card p-5 space-y-2">
        <Row label="Subtotal" value={formatPrice(order.subtotalCents, order.currency)} />
        <Row label="Shipping" value={formatPrice(order.shippingCents, order.currency)} />
        <Row label="VAT" value={formatPrice(order.taxCents, order.currency)} />
        <div className="pt-2 border-t mt-2">
          <Row label="Total" value={formatPrice(order.totalCents, order.currency)} bold />
        </div>
      </div>
    </div>
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
