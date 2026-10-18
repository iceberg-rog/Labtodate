import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getServerSession, requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';
import { OfferCard } from '@/components/quotes/OfferCard';
import { messageAuthorLabel, unitUnavailable } from '@/components/quotes/quote-view';
import { computeDealState } from '@/lib/quotes/deal-state';
import { offerCardProps } from '@/lib/quotes/offer-view';
import { acceptContextFor, cancelContext, declineContext } from '@/lib/quotes/page-data';
import { parseOfferTerms } from '@/lib/quotes/pricing';
import { unitAvailability } from '@/lib/quotes/stock';
import { buyerCanCancelUnpaid } from '@/lib/quotes/policy';
import { buyerCancelExplanation } from '@/lib/orders/cancel-reason';
import { quotationPath } from '@/lib/documents/quotation';
import { siteName } from '@/lib/brand/identity';
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
  const brand = siteName();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true, vatScheme: true } },
      messages: {
        where: { isInternalNote: false }, // hard-filter — buyer never sees admin/seller chatter
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true, role: true } } },
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
      vatTreatment: true, vatRateBp: true, dueAt: true, financialStatus: true, adminNotes: true,
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
  // Who ended the deal, in the buyer's words (the order page uses the same).
  const endedWhy = endedWithoutDeal && linkedOrder
    ? buyerCancelExplanation({
        quote: { status: sr.status, lostReason: sr.lostReason, lostNote: sr.lostNote },
        adminNotes: linkedOrder.adminNotes,
        proformaVoidReason: (await prisma.fiscalDocument.findFirst({
          where: { orderId: linkedOrder.id, kind: 'PROFORMA' },
          orderBy: { createdAt: 'desc' },
          select: { voidReason: true },
        }))?.voidReason ?? null,
      })
    : null;

  const isOpenOffer = isBuyer && sr.status === 'RESPONDED' && sr.quotedPriceCents != null;
  // A competing acceptance (or order) took the listed unit: the offer can not
  // be accepted any more — say so instead of letting the buyer fill in step 1.
  const unavailable = isOpenOffer && sr.productId
    ? unitUnavailable(await unitAvailability(sr.productId, sr.id), parseOfferTerms(sr.offerTerms)?.qty ?? 1)
    : false;
  const baseOffer = offerCardProps(sr, linkedOrder, isBuyer ? 'BUYER' : 'STAFF', {
    accept: isOpenOffer && !unavailable ? await acceptContextFor(sr, session.user.id) : null,
    decline: isOpenOffer ? declineContext() : null,
    cancel: isBuyer && linkedOrder && buyerCanCancelUnpaid() ? cancelContext(linkedOrder.orderNumber) : null,
    invoiceNumber: linkedOrder?.documents[0]?.number ?? null,
  });
  const offer = baseOffer && {
    ...baseOffer,
    brand,
    quoteStatus: sr.status,
    // The quotation PDF of the revision on screen (PO paperwork) — never for an offer that was never sent.
    quotationHref: (sr.offerRevision ?? 0) > 0 ? quotationPath(sr.id, sr.offerRevision) : null,
    unavailable: unavailable ? 'The listed unit was sold or reserved for another order meanwhile.' : null,
    currencyChangedFrom: parseOfferTerms(sr.offerTerms)?.previous?.currency ?? null,
  };
  // After dispatch the questions are about the order: support, with its number.
  const supportOrderNumber =
    isBuyer && linkedOrder && ['SHIPPED', 'DELIVERED', 'REFUNDED'].includes(linkedOrder.status) ? linkedOrder.orderNumber : null;

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
    {endedWhy && linkedOrder && (
      <p className="mb-5 rounded-xl border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="quote-ended-banner">
        <strong className="text-foreground">{endedWhy.title}</strong>
        {endedWhy.detail && <span dir="auto"> {endedWhy.detail}</span>}{' '}
        Order <span className="font-mono">{linkedOrder.orderNumber}</span> — no payment is due.{' '}
        <a href={`/app/orders/${linkedOrder.orderNumber}`} className="font-semibold text-primary hover:underline">
          View canceled order
        </a>
      </p>
    )}
    {offer && <OfferCard {...offer} />}
    <QuoteThread
      sourcingRequestId={sr.id}
      brand={brand}
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
        // The buyer sees our side as the brand (staff) or "Supplier" — never a
        // person's name; staff opening the page see names.
        authorName: messageAuthorLabel(
          m,
          isBuyer ? { kind: 'BUYER', userId: session.user.id, brand } : { kind: 'STAFF', userId: session.user.id, brand, buyerName: sr.buyerName },
        ),
        authorEmail: staffView && !isBuyer ? (m.author?.email ?? null) : null,
        // Every buyer-side message is the buyer's own (also a reply sent from the magic link).
        isMine: isBuyer ? !m.fromStaff : m.author?.id === session.user.id,
        fromStaff: m.fromStaff,
        attachments: m.attachments,
        attachmentNames: m.attachmentNames,
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
      supportOrderNumber={supportOrderNumber}
    />
    </>
  );
}
