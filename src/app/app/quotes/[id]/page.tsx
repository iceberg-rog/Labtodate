import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getServerSession, requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';
import { OfferCard } from '@/components/quotes/OfferCard';
import { computeDealState } from '@/lib/quotes/deal-state';
import { offerCardProps } from '@/lib/quotes/offer-view';
import { acceptContextFor, cancelContext, declineContext } from '@/lib/quotes/page-data';
import { buyerCanCancelUnpaid } from '@/lib/quotes/policy';
import { ensureSettingsLoaded } from '@/lib/settings';
import { QUOTE_REF } from '@/lib/quotes/offer';

export const dynamic = 'force-dynamic';

// Same reference the quotes list shows (proforma number once issued). Only the
// buyer (or an admin) gets it — anyone else keeps the generic site title, as
// the page itself is a 404 for them.
export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await props.params;
  const session = await getServerSession();
  if (!session) return {};
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: { id: true, submittedById: true, buyerEmail: true, proformaNumber: true },
  });
  if (!sr) return {};
  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  const isBuyer = sr.submittedById === session.user.id || sr.buyerEmail === session.user.email;
  if (!isBuyer && !staffView) return {};
  return { title: `Quote ${sr.proformaNumber ?? QUOTE_REF(sr.id)}` };
}

export default async function BuyerQuoteDetailPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ history?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/quotes/${params.id}` });
  await ensureSettingsLoaded();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true, vatScheme: true } },
      messages: {
        where: { isInternalNote: false }, // hard-filter — buyer never sees admin/seller chatter
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!sr) notFound();

  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  const isBuyer = sr.submittedById === session.user.id || sr.buyerEmail === session.user.email;
  if (!isBuyer && !staffView) notFound();

  // Once the buyer accepts the offer it becomes a real order (created by
  // acceptOffer, never earlier) — the offer card links to its payment page.
  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: {
      id: true, orderNumber: true, status: true, paymentSubmittedAt: true, paymentVerificationStatus: true,
      subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true, currency: true,
      vatTreatment: true, vatRateBp: true, dueAt: true, financialStatus: true,
      items: { select: { quantity: true, priceCentsSnapshot: true }, take: 1 },
      documents: { where: { kind: 'INVOICE' }, select: { number: true }, take: 1 },
    },
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
    isBuyer && !staffView && !!linkedOrder && POST_QUOTE_STATES.includes(linkedOrder.status) && !endedWithoutDeal;
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
    {await (async () => {
      const isOpenOffer = isBuyer && sr.status === 'RESPONDED' && sr.quotedPriceCents != null;
      const offer = offerCardProps(sr, linkedOrder, isBuyer ? 'BUYER' : 'STAFF', {
        accept: isOpenOffer ? await acceptContextFor(sr, session.user.id) : null,
        decline: isOpenOffer ? declineContext() : null,
        cancel: isBuyer && linkedOrder && buyerCanCancelUnpaid() ? cancelContext(linkedOrder.orderNumber) : null,
        invoiceNumber: linkedOrder?.documents[0]?.number ?? null,
      });
      return offer ? <OfferCard {...offer} /> : null;
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
            : staffView
              ? (m.author?.name ?? null)
              : 'lab2date Supplier',
        authorEmail: staffView ? (m.author?.email ?? null) : null,
        isMine: m.author?.id === session.user.id,
        fromStaff: m.fromStaff,
        attachments: m.attachments,
      }))}
      viewerRole="BUYER"
      createdAt={sr.createdAt.toISOString()}
      dealBadge={computeDealState({
        status: sr.status,
        lastReplyByStaff: sr.lastReplyByStaff,
        proformaNumber: sr.proformaNumber,
        quotedPriceCents: sr.quotedPriceCents,
        validUntilAt: sr.validUntilAt,
        linkedOrder,
        archivedAt: sr.archivedAt, // BUG-019: buyer-facing closure for archived RFQs
      }, 'buyer')}
    />
    </>
  );
}
