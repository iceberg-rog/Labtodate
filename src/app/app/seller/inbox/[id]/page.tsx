import { notFound } from 'next/navigation';
import { Lightbulb } from 'lucide-react';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';
import { OfferCard } from '@/components/quotes/OfferCard';
import { computeDealState } from '@/lib/quotes/deal-state';
import { offerCardProps, offerFormProps } from '@/lib/quotes/offer-view';
import { offerFormContextFor } from '@/lib/quotes/page-data';
import { sellerOffersRequireApproval, sellerSeesSellPrice } from '@/lib/quotes/policy';
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

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true, vatScheme: true } },
      messages: {
        // Sellers should not see admin internal notes (admin chatter about
        // the seller). Admins see everything.
        where: sellerIsAdmin ? undefined : { isInternalNote: false },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!sr) notFound();

  if (sr.assignedToId !== session.user.id && !staffView) notFound();

  // Sellers never see who the buyer is — lab2date mediates. Admins (acting as
  // the mediator) still see the real buyer to coordinate.
  const isAdmin = staffView;
  const buyerName = isAdmin ? sr.buyerName : 'lab2date Buyer';
  const buyerEmail = isAdmin ? sr.buyerEmail : 'Hidden — reply here, lab2date relays it';
  // No buyer identity and no buyer documents for the supplier (those carry
  // the buyer's details) — and, unless the owner allows it, not lab2date's
  // buyer price / margin either (SELLER_SEES_SELL_PRICE).
  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: {
      orderNumber: true, status: true, paymentSubmittedAt: true, paymentVerificationStatus: true,
      subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true, currency: true,
      vatTreatment: true, vatRateBp: true, dueAt: true, financialStatus: true,
      items: { select: { quantity: true, priceCentsSnapshot: true }, take: 1 },
    },
  });
  const showSellPrice = isAdmin || sellerSeesSellPrice();
  const offer = showSellPrice ? offerCardProps(sr, linkedOrder, 'STAFF') : null;
  const lastPublic = sr.messages.filter((m) => !m.isInternalNote).at(-1);
  const review = sellerOffersRequireApproval();
  const formCtx = await offerFormContextFor(
    sr,
    isAdmin ? 'STAFF' : 'SELLER',
    isAdmin ? `Emailed to ${sr.buyerEmail}.` : review ? 'Your price goes to lab2date for review; lab2date sends the buyer the offer (the buyer stays anonymous to you).' : 'lab2date sends the buyer an offer at your price plus its margin (the buyer stays anonymous to you).',
  );
  const baseForm = offerFormProps(sr, linkedOrder, formCtx);
  // A supplier's form starts from THEIR last proposal — never from lab2date's buyer price.
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

  return (
    <>
    <AutoRefresh />
    {offer && <OfferCard {...offer} />}
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
          {sr.sellerProposalStatus === 'PENDING' ? 'Waiting for lab2date review — the buyer has not seen an offer yet.'
            : sr.sellerProposalStatus === 'APPROVED' ? (sr.status === 'ACCEPTED' ? 'The buyer accepted lab2date’s offer.' : 'lab2date sent the buyer an offer based on your price.')
            : 'Not used by lab2date.'}
        </p>
        {sr.sellerProposalStatus === 'REJECTED' && sr.sellerProposalReviewNote && (
          <p className="mt-1 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{sr.sellerProposalReviewNote}</p>
        )}
      </section>
    )}
    <QuoteThread
      sourcingRequestId={sr.id}
      buyerName={buyerName}
      buyerEmail={buyerEmail}
      description={sr.description}
      status={sr.status}
      product={sr.product}
      productCategory={sr.productCategory}
      messages={sr.messages.map((m) => ({
        id: m.id,
        body: !isAdmin && !showSellPrice && m.author?.id !== session.user.id && /^(Updated offer|Offer) \(revision|^Offer accepted/.test(m.body)
          ? (/^Offer accepted/.test(m.body) ? 'The buyer accepted lab2date’s offer. (Buyer prices are not shown to suppliers.)' : 'lab2date sent the buyer an offer. (Buyer prices are not shown to suppliers.)')
          : m.body,
        createdAt: m.createdAt.toISOString(),
        // Sellers see the other side as "lab2date Buyer", and staff messages
        // as "lab2date team" — never a person's name.
        authorName: m.author?.id === session.user.id
          ? 'You'
          : isAdmin ? (m.author?.name ?? null)
          : m.fromStaff ? 'lab2date team' : 'lab2date Buyer',
        authorEmail: isAdmin ? (m.author?.email ?? null) : null,
        isMine: m.author?.id === session.user.id,
        fromStaff: m.fromStaff,
        // Only admins receive notes (see the query above); label them so a
        // note is never mistaken for a reply the buyer saw.
        isInternalNote: m.isInternalNote,
        attachments: m.attachments,
      }))}
      viewerRole="SELLER"
      createdAt={sr.createdAt.toISOString()}
      dealBadge={computeDealState({
        status: sr.status,
        lastReplyByStaff: lastPublic ? lastPublic.fromStaff : sr.lastReplyByStaff,
        proformaNumber: sr.proformaNumber,
        quotedPriceCents: sr.quotedPriceCents,
        validUntilAt: sr.validUntilAt,
        linkedOrder,
      }, 'staff')}
      offerForm={form ? { ...form, sellerDirect: !isAdmin && !review } : null}
      canClose={isAdmin ? false : sr.status === 'PENDING' || sr.status === 'RESPONDED'}
    />
    </>
  );
}
