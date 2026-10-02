import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';
import { computeDealState } from '@/lib/quotes/deal-state';

export const dynamic = 'force-dynamic';

export default async function BuyerQuoteDetailPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ history?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/quotes/${params.id}` });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true } },
      messages: {
        where: { isInternalNote: false }, // hard-filter — buyer never sees admin/seller chatter
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!sr) notFound();

  const role = (session.user as { role?: string }).role;
  const isBuyer = sr.submittedById === session.user.id || sr.buyerEmail === session.user.email;
  if (!isBuyer && role !== 'ADMIN') notFound();

  // If this quote was accepted it became a real order — link straight to it
  // so the buyer can pay and provide delivery details (not a dead end).
  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { orderNumber: true, status: true },
  });

  // Once admin verifies payment, the quote thread has done its job — every
  // further interaction (track, invoice, return, support) lives on the order
  // page. Buyers are redirected so they don't keep landing on a stale "reply
  // to supplier / decline" UI for a deal they already paid for. Admins still
  // see the thread for audit, and buyers can force-see it with ?history=1
  // (linked from the order page so the conversation isn't lost).
  const POST_QUOTE_STATES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED', 'REFUNDED'];
  // Declining (or closing) a quote cancels its unpaid order. That order page
  // only says "Canceled", so the quote thread stays the buyer's view of the
  // deal: it says what happened, and the order is linked as a side note.
  const endedWithoutDeal =
    (sr.status === 'DECLINED' || sr.status === 'CLOSED') && linkedOrder?.status === 'CANCELED';
  const orderTakesOver =
    isBuyer && role !== 'ADMIN' && !!linkedOrder && POST_QUOTE_STATES.includes(linkedOrder.status) && !endedWithoutDeal;
  if (orderTakesOver && linkedOrder && searchParams.history !== '1') {
    redirect(`/app/orders/${linkedOrder.orderNumber}`);
  }

  const inHistoryMode = orderTakesOver && searchParams.history === '1';

  return (
    <>
    <AutoRefresh />
    {inHistoryMode && linkedOrder && (
      <div className="mb-5 rounded-xl border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between gap-3 flex-wrap">
        <span>
          📜 You're viewing the original quote conversation. Live actions for this deal live on the order page.
        </span>
        <a
          href={`/app/orders/${linkedOrder.orderNumber}`}
          className="font-semibold text-primary hover:underline"
        >
          ← Back to order
        </a>
      </div>
    )}
    {endedWithoutDeal && linkedOrder && (
      <p className="mb-5 rounded-xl border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground">
        {sr.status === 'DECLINED' ? 'You declined this quote' : 'This request was closed'}, so order{' '}
        <span className="font-mono">{linkedOrder.orderNumber}</span> was canceled.{' '}
        <a href={`/app/orders/${linkedOrder.orderNumber}`} className="font-semibold text-primary hover:underline">
          View canceled order
        </a>
      </p>
    )}
    {linkedOrder && !(
      // A declined/closed deal has no live order: no banner inviting payment.
      (sr.status === 'DECLINED' || sr.status === 'CLOSED') &&
      (linkedOrder.status === 'PENDING_PAYMENT' || linkedOrder.status === 'CANCELED')
    ) && (() => {
      const s = linkedOrder.status;
      const isPending = s === 'PENDING_PAYMENT';
      const isPaid = s === 'PAID';
      const isShipping = s === 'PROCESSING' || s === 'SHIPPED';
      const isDelivered = s === 'DELIVERED';
      const isDead = s === 'CANCELED' || s === 'REFUNDED';
      // The order exists from the moment the proforma is sent; "Accepted" only
      // once the buyer actually accepted it.
      const headline =
        isPending && sr.status !== 'ACCEPTED' ? `Proforma ready — order ${linkedOrder.orderNumber} · complete your purchase`
          : isPending ? `Accepted — order ${linkedOrder.orderNumber} · awaiting your payment`
          : isPaid ? `Paid — order ${linkedOrder.orderNumber} · we are preparing your shipment`
          : isShipping ? `Order ${linkedOrder.orderNumber} · ${s.toLowerCase()}`
          : isDelivered ? `Delivered — order ${linkedOrder.orderNumber}`
          : isDead ? `Order ${linkedOrder.orderNumber} · ${s.toLowerCase()}`
          : `Accepted — order ${linkedOrder.orderNumber}`;
      const sub =
        isPending ? 'Provide delivery details, upload your transfer receipt, and we\'ll verify within 1 business day.'
          : isPaid ? 'No action needed — you\'ll get an email when the shipment is on its way.'
          : isShipping ? 'Track your shipment + invoice from the order page.'
          : isDelivered ? 'Need help? Request a return from the order page.'
          : isDead ? 'This order is closed. Open a fresh request if you still need the item.'
          : '';
      const tone = isPending ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40'
        : isDead ? 'border-border bg-muted'
        : isDelivered || isShipping || isPaid ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40'
        : 'border-primary/40 bg-primary/[0.06]';
      const cta = isPending
        ? { label: 'Complete your purchase', href: `/app/orders/${linkedOrder.orderNumber}/payment` }
        : { label: 'Open order', href: `/app/orders/${linkedOrder.orderNumber}` };
      return (
        <div className={`mb-5 rounded-2xl border-2 p-5 flex items-center justify-between gap-4 flex-wrap ${tone}`}>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{headline}</p>
            {sub && <p className="text-sm mt-1">{sub}</p>}
          </div>
          <a
            href={cta.href}
            className="rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90"
          >
            {cta.label} →
          </a>
        </div>
      );
    })()}
    {sr.quotedPriceCents != null && (() => {
      // The deal ended (declined / closed / its order canceled): the price card
      // stays for reference but must not read as a live, payable offer.
      const quoteVoid = sr.status === 'DECLINED' || sr.status === 'CLOSED' || linkedOrder?.status === 'CANCELED';
      return (
        <div
          className={`mb-5 rounded-2xl border-2 p-5 flex items-center justify-between gap-4 flex-wrap ${
            quoteVoid ? 'border-border bg-muted' : 'border-accent/40 bg-accent/[0.05]'
          }`}
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {quoteVoid ? 'Quoted price · void, no payment due' : 'Quoted price'}
            </p>
            <p className={`text-2xl font-bold data mt-1 ${quoteVoid ? 'line-through text-muted-foreground' : ''}`}>
              {((sr.quotedPriceCents) / 100).toLocaleString()} {sr.quotedCurrency || 'EUR'}
            </p>
          </div>
          <a
            href={`/app/quotes/${sr.id}/proforma`}
            className={
              quoteVoid
                ? 'rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-muted-foreground hover:text-foreground'
                : 'rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90'
            }
          >
            {quoteVoid ? 'View void proforma' : 'View / download proforma'}
          </a>
        </div>
      );
    })()}
    <QuoteThread
      sourcingRequestId={sr.id}
      buyerName={sr.buyerName}
      buyerEmail={sr.buyerEmail}
      description={sr.description}
      status={sr.status}
      product={sr.product}
      productCategory={sr.productCategory}
      messages={sr.messages.map((m) => ({
        id: m.id,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        authorName:
          m.author?.id === session.user.id
            ? 'You'
            : role === 'ADMIN'
              ? (m.author?.name ?? null)
              : 'lab2date Verified Supplier',
        authorEmail: role === 'ADMIN' ? (m.author?.email ?? null) : null,
        isMine: m.author?.id === session.user.id,
        fromStaff: m.fromStaff,
        attachments: m.attachments,
      }))}
      viewerRole="BUYER"
      createdAt={sr.createdAt.toISOString()}
      hasProforma={sr.quotedPriceCents != null && !!sr.proformaNumber}
      // Only surface "Complete your purchase" while the order is actually
      // accepting payment. Once it advances to PAID/PROCESSING/SHIPPED/
      // DELIVERED the buyer must NOT be invited to "pay again".
      orderPaymentHref={
        linkedOrder && linkedOrder.status === 'PENDING_PAYMENT'
          ? `/app/orders/${linkedOrder.orderNumber}/payment`
          : null
      }
      dealBadge={computeDealState({
        status: sr.status,
        lastReplyByStaff: sr.lastReplyByStaff,
        proformaNumber: sr.proformaNumber,
        linkedOrder: linkedOrder ? { status: linkedOrder.status } : null,
        archivedAt: sr.archivedAt, // BUG-019: buyer-facing closure for archived RFQs
      })}
    />
    </>
  );
}
