import { notFound } from 'next/navigation';
import { Lightbulb, Truck } from 'lucide-react';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';
import { OfferCard } from '@/components/quotes/OfferCard';
import { messageAuthorLabel, supplierSafeBody, withFulfilment } from '@/components/quotes/quote-view';
import { computeDealState } from '@/lib/quotes/deal-state';
import { offerCardProps, offerFormProps } from '@/lib/quotes/offer-view';
import { offerFormContextFor } from '@/lib/quotes/page-data';
import { parseOfferTerms } from '@/lib/quotes/pricing';
import { sellerOffersRequireApproval, sellerSeesSellPrice } from '@/lib/quotes/policy';
import { countryOptions } from '@/lib/compliance/country';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formatPrice } from '@/lib/utils';
import { QUOTE_REF } from '@/lib/quotes/offer';

export const dynamic = 'force-dynamic';

// The reference comes from the id alone (no lookup), so the title never says
// more than the URL already does to someone who cannot open the quote.
export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return { title: `Quote ${QUOTE_REF(id)}` };
}

export default async function SellerQuoteDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: `/app/seller/inbox/${params.id}` });
  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  const sellerIsAdmin = staffView;
  await ensureSettingsLoaded();
  const brand = siteName();
  const timeZone = businessTimeZone();
  const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true, vatScheme: true } },
      messages: {
        // Sellers should not see admin internal notes (admin chatter about
        // the seller). Admins see everything.
        where: sellerIsAdmin ? undefined : { isInternalNote: false },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true, role: true } } },
      },
    },
  });
  if (!sr) notFound();

  if (sr.assignedToId !== session.user.id && !staffView) notFound();

  // Sellers never see who the buyer is — we mediate. Admins (acting as the
  // mediator) still see the real buyer to coordinate.
  const isAdmin = staffView;
  const buyerName = isAdmin ? sr.buyerName : 'Buyer';
  const buyerEmail = isAdmin ? sr.buyerEmail : `Hidden — reply here, ${brand} relays it`;
  // No buyer identity and no buyer documents for the supplier (those carry
  // the buyer's details) — and, unless the owner allows it, not our buyer
  // price / margin either (SELLER_SEES_SELL_PRICE). Shipping dates are fine.
  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: {
      orderNumber: true, status: true, paymentSubmittedAt: true, paymentVerificationStatus: true,
      subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true, currency: true,
      vatTreatment: true, vatRateBp: true, dueAt: true, financialStatus: true, shippedAt: true, deliveredAt: true,
      items: { select: { quantity: true, priceCentsSnapshot: true }, take: 1 },
    },
  });
  const showSellPrice = isAdmin || sellerSeesSellPrice();
  const baseOffer = showSellPrice ? offerCardProps(sr, linkedOrder, 'STAFF') : null;
  const offer = baseOffer
    ? { ...baseOffer, brand, quoteStatus: sr.status, currencyChangedFrom: parseOfferTerms(sr.offerTerms)?.previous?.currency ?? null }
    : null;
  const lastPublic = sr.messages.filter((m) => !m.isInternalNote).at(-1);
  const review = sellerOffersRequireApproval();
  const formCtx = await offerFormContextFor(
    sr,
    isAdmin ? 'STAFF' : 'SELLER',
    isAdmin
      ? `Emailed to ${sr.buyerEmail}.`
      : review
        ? `Your price goes to ${brand} for review; ${brand} sends the buyer the offer (the buyer stays anonymous to you).`
        : `${brand} sends the buyer an offer at your price plus its margin (the buyer stays anonymous to you).`,
  );
  const baseForm = offerFormProps(sr, linkedOrder, formCtx);
  // A supplier's form starts from THEIR last proposal — never from our buyer price.
  const st = sr.sellerProposalTerms && typeof sr.sellerProposalTerms === 'object' ? (sr.sellerProposalTerms as Record<string, unknown>) : {};
  const form = baseForm && !isAdmin
    ? {
        ...baseForm,
        current: sr.sellerProposalCents != null
          ? {
              unitCents: sr.sellerProposalCents, qty: 1, currency: sr.sellerProposalCurrency ?? baseForm.defaults.currency, shippingCents: 0,
              note: sr.sellerProposalNote, validUntilISO: sr.validUntilAt?.toISOString() ?? null, expired: false, incoterm: null, incotermPlace: null,
              leadTime: typeof st.leadTime === 'string' ? st.leadTime : '', warranty: typeof st.warranty === 'string' ? st.warranty : '',
              paymentDays: baseForm.defaults.paymentDays, revision: 0,
            }
          : null,
      }
    : baseForm;
  const countries = form && isAdmin ? await countryOptions() : undefined;
  // Fulfilment of a sold unit, for the supplier who prepares it (dates only).
  const sold = !!linkedOrder && ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(linkedOrder.status);

  return (
    <>
    <AutoRefresh />
    {offer && <OfferCard {...offer} />}
    {!isAdmin && sold && linkedOrder && (
      <section className="mb-5 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 text-sm" data-testid="seller-fulfilment-card">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground inline-flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5" /> Delivery
        </p>
        <p className="mt-1 font-semibold">
          {linkedOrder.deliveredAt
            ? `Delivered on ${fmtDay(linkedOrder.deliveredAt)}.`
            : linkedOrder.shippedAt
              ? `Shipped on ${fmtDay(linkedOrder.shippedAt)} — not delivered yet.`
              : `Paid — ${brand} arranges the dispatch; the unit has not shipped yet.`}
        </p>
        {linkedOrder.deliveredAt && linkedOrder.shippedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">Shipped on {fmtDay(linkedOrder.shippedAt)}.</p>
        )}
      </section>
    )}
    {!isAdmin && sr.sellerProposalStatus && (
      <section className="mb-5 rounded-2xl border-2 border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 p-4 text-sm" data-testid="seller-proposal-card">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground inline-flex items-center gap-1.5">
          <Lightbulb className="h-3.5 w-3.5" /> Your proposal
        </p>
        <p className="mt-1">
          <strong className="tabular-nums">{formatPrice(sr.sellerProposalCents ?? 0, sr.sellerProposalCurrency ?? 'EUR')}</strong> excl. VAT
          {sr.sellerProposalAt && <span className="text-muted-foreground"> · sent {sr.sellerProposalAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
        </p>
        <p className="mt-1 font-semibold">
          {sr.sellerProposalStatus === 'PENDING' ? `Waiting for ${brand} review — the buyer has not seen an offer yet.`
            : sr.sellerProposalStatus === 'APPROVED' ? (sr.status === 'ACCEPTED' ? `The buyer accepted ${brand}’s offer.` : `${brand} sent the buyer an offer based on your price.`)
            : `Not used by ${brand}.`}
        </p>
        {sr.sellerProposalStatus === 'REJECTED' && sr.sellerProposalReviewNote && (
          <p className="mt-1 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{sr.sellerProposalReviewNote}</p>
        )}
      </section>
    )}
    <QuoteThread
      sourcingRequestId={sr.id}
      brand={brand}
      buyerName={buyerName}
      buyerEmail={buyerEmail}
      description={sr.description}
      status={sr.status}
      product={sr.product}
      productCategory={sr.productCategory}
      messages={sr.messages.map((m) => ({
        id: m.id,
        // Suppliers never read our buyer price (offer / acceptance messages,
        // whoever wrote them) nor the buyer's documents (cancel messages).
        body: isAdmin ? m.body : supplierSafeBody(m.body, { brand, showSellPrice }),
        createdAt: m.createdAt.toISOString(),
        // Suppliers see the other side as "Buyer" and our messages under the
        // brand — never a person's name. Admins see names.
        authorName: messageAuthorLabel(
          m,
          isAdmin ? { kind: 'STAFF', userId: session.user.id, brand, buyerName: sr.buyerName } : { kind: 'SELLER', userId: session.user.id, brand },
        ),
        authorEmail: isAdmin ? (m.author?.email ?? null) : null,
        isMine: m.author?.id === session.user.id,
        fromStaff: m.fromStaff,
        // Only admins receive notes (see the query above); label them so a
        // note is never mistaken for a reply the buyer saw.
        isInternalNote: m.isInternalNote,
        attachments: m.attachments,
        attachmentNames: m.attachmentNames,
      }))}
      viewerRole="SELLER"
      createdAt={sr.createdAt.toISOString()}
      dealBadge={withFulfilment(computeDealState({
        status: sr.status,
        lastReplyByStaff: lastPublic ? lastPublic.fromStaff : sr.lastReplyByStaff,
        proformaNumber: sr.proformaNumber,
        quotedPriceCents: sr.quotedPriceCents,
        validUntilAt: sr.validUntilAt,
        linkedOrder,
      }, 'staff'), linkedOrder)}
      offerForm={form ? { ...form, brand, countries, sellerDirect: !isAdmin && !review } : null}
      canHandBack={!isAdmin && (sr.status === 'PENDING' || sr.status === 'RESPONDED') && (!linkedOrder || linkedOrder.status === 'CANCELED')}
    />
    </>
  );
}
