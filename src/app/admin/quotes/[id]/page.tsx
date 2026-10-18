import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Crown, ShieldAlert, AlertCircle, ShoppingBag, ExternalLink,
  Building2, FileText, Hourglass, ArrowRight, Package, MailWarning,
} from 'lucide-react';
import { requireCapability, getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { EmailText } from '@/components/util/EmailText';
import { QuoteComposer } from '@/components/admin/QuoteComposer';
import { QuoteHeaderControls } from '@/components/admin/QuoteHeaderControls';
import { QuoteReissueMagicLink } from '@/components/admin/QuoteReissueMagicLink';
import { computeDealState, toneClasses } from '@/lib/quotes/deal-state';
import { DealStateBadge } from '@/components/quotes/DealStateBadge';
import { AssigneeBadge } from '@/components/quotes/AssigneeBadge';
import { DealStepper } from '@/components/quotes/DealStepper';
import { OfferCard } from '@/components/quotes/OfferCard';
import { dealStageOf, messageAuthorLabel, partPaidLine, showsQuotationPdf, withFulfilment } from '@/components/quotes/quote-view';
import { offerCardProps, offerFormProps, orderPaymentState, priceLockedMessage } from '@/lib/quotes/offer-view';
import { offerFormContextFor } from '@/lib/quotes/page-data';
import { parseOfferTerms } from '@/lib/quotes/pricing';
import { autoArchiveOnClose } from '@/lib/quotes/policy';
import { documentHref } from '@/lib/documents';
import { quotationPath } from '@/lib/documents/quotation';
import { countryOptions } from '@/lib/compliance/country';
import { LIVE_REFUNDS_SELECT } from '@/lib/finance/held';
import { SUPPRESS_ALL_SCOPE } from '@/lib/email-guard';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { ensureSettingsLoaded, settingList } from '@/lib/settings';
import { QuoteDealPanel } from '@/components/admin/QuoteDealPanel';
import { SellerProposalReject } from '@/components/admin/SellerProposalReject';
import { fmtDueDate } from '@/lib/orders/payment-due';
import { creditStatusFor } from '@/lib/credit/terms';
import { BuyerIntelCard } from '@/components/quotes/BuyerIntelCard';
import { ActivityTimeline } from '@/components/quotes/ActivityTimeline';
import { buildBuyerIntel } from '@/lib/quotes/buyer-intel';
import { buildActivityTimeline } from '@/lib/quotes/activity-timeline';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { formatPrice } from '@/lib/utils';
import { QUOTE_REF } from '@/lib/quotes/offer';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ id: string }> }) {
  return adminDetailTitle('quotes:view', 'Quote request', async () => {
    const { id } = await props.params;
    const sr = await prisma.sourcingRequest.findUnique({ where: { id }, select: { id: true, proformaNumber: true } });
    return sr && `Quote ${sr.proformaNumber ?? QUOTE_REF(sr.id)}`;
  });
}

function priorityChip(priority: string) {
  const styles: Record<string, { cls: string; icon: JSX.Element; label: string }> = {
    VIP:    { cls: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800', icon: <Crown className="h-3 w-3" />,       label: 'VIP' },
    URGENT: { cls: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800',          icon: <ShieldAlert className="h-3 w-3" />, label: 'URGENT' },
    HIGH:   { cls: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',    icon: <AlertCircle className="h-3 w-3" />, label: 'HIGH' },
    NORMAL: { cls: 'bg-muted text-muted-foreground border-border',    icon: <></>,                              label: 'normal' },
    LOW:    { cls: 'bg-muted text-muted-foreground border-border',     icon: <></>,                              label: 'low' },
  };
  const s = styles[priority] ?? styles.NORMAL;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${s.cls}`}>
      {s.icon}{s.label}
    </span>
  );
}

function fmtMoney(cents: number, ccy = 'EUR'): string {
  return formatPrice(cents, ccy); // shows cents when present — must match the proforma
}

/** EmailLog statuses that mean the mail did not leave (sent = handed to the mail server). */
const MAIL_NOT_SENT: Record<string, string> = {
  failed: 'the mail server refused it',
  blocked: 'the address or its domain is refused',
  suppressed: 'the address bounced before, so mails to it are stopped',
  throttled: 'too many mails to this address',
  not_configured: 'e-mail is not configured on this server',
};

export default async function AdminQuoteDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('quotes:view');
  await ensureSettingsLoaded();
  const session = await getServerSession();
  const brand = siteName();
  const timeZone = businessTimeZone();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true, role: true } } },
      },
      assignedTo: { select: { id: true, name: true, email: true } },
      submittedBy: { select: { id: true, name: true, email: true, createdAt: true, company: { select: { name: true } } } },
      product: { select: { id: true, title: true, slug: true, vatScheme: true, status: true } },
    },
  });
  if (!sr) notFound();

  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, currency: true, paidAt: true,
      paymentSubmittedAt: true, paymentVerificationStatus: true, subtotalCents: true, shippingCents: true, taxCents: true,
      vatTreatment: true, vatRateBp: true, dueAt: true, financialStatus: true, shippedAt: true, deliveredAt: true,
      amountPaidCents: true, refunds: LIVE_REFUNDS_SELECT,
      items: { select: { quantity: true, priceCentsSnapshot: true }, take: 1 },
      documents: { where: { kind: 'INVOICE' }, select: { number: true }, take: 1 },
    },
  });

  // What this staff member may do here: a control shows only with the
  // permission its action needs (an OPS role with quotes:view only reads).
  const buyerAddr = sr.buyerEmail.trim();
  const [intel, timeline, admins, canStatus, canSendOffer, canReply, canArchive, canAssign, canRefund, lastMail, suppression] = await Promise.all([
    buildBuyerIntel(sr.buyerEmail, sr.submittedBy?.id ?? null),
    buildActivityTimeline(sr.id),
    prisma.user.findMany({
      where: { OR: [{ role: 'ADMIN' }, { role: 'SELLER' }] },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 30,
    }),
    hasCapability('quotes:status'),
    hasCapability('quotes:proforma'),
    hasCapability('quotes:reply'),
    hasCapability('quotes:archive'),
    hasCapability('quotes:assign'),
    hasCapability('orders:refund'),
    // The last e-mail to the buyer: a failure (bad domain, bounce) must not
    // stay hidden in the e-mail log while staff wait for an answer.
    prisma.emailLog.findFirst({
      where: { toAddr: { in: Array.from(new Set([buyerAddr, buyerAddr.toLowerCase()])) } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, error: true, subject: true, createdAt: true },
    }),
    prisma.emailSuppression.findUnique({
      where: { email_scope: { email: buyerAddr.toLowerCase(), scope: SUPPRESS_ALL_SCOPE } },
      select: { reason: true, createdAt: true },
    }),
  ]);
  const fmtWhen = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });

  const deal = withFulfilment(computeDealState({
    status: sr.status,
    lastReplyByStaff: sr.lastReplyByStaff,
    proformaNumber: sr.proformaNumber,
    quotedPriceCents: sr.quotedPriceCents,
    validUntilAt: sr.validUntilAt,
    linkedOrder,
  }, 'staff'), linkedOrder);
  const baseCard = offerCardProps(sr, linkedOrder, 'STAFF', { invoiceNumber: linkedOrder?.documents[0]?.number ?? null });
  // The quotation PDF of the current revision, once the PDF route is served.
  const quotationHref = baseCard && showsQuotationPdf({ offerRevision: sr.offerRevision, phase: baseCard.phase, viewer: 'staff' })
    ? quotationPath(sr.id, sr.offerRevision)
    : null;
  const offerCard = baseCard && {
    ...baseCard,
    brand,
    quoteStatus: sr.status,
    quotationHref,
    currencyChangedFrom: parseOfferTerms(sr.offerTerms)?.previous?.currency ?? null,
  };
  const invoiceNumber = linkedOrder?.documents[0]?.number ?? null;
  const payState = linkedOrder ? orderPaymentState(linkedOrder) : null;
  const dealStage = linkedOrder ? dealStageOf(linkedOrder, payState === 'terms') : null;
  // Money already received on an unpaid order: never shown as the full amount due.
  const partPaid = linkedOrder && linkedOrder.status === 'PENDING_PAYMENT' ? partPaidLine(linkedOrder) : null;
  const credit = sr.submittedById ? await creditStatusFor(sr.submittedById, offerCard?.amounts.totalCents ?? 0, offerCard?.currency ?? 'EUR') : null;
  const dealTone = toneClasses(deal.tone);
  // Both references: the request's own and, once accepted, the proforma's.
  const quoteRef = QUOTE_REF(sr.id);
  const title = sr.product?.title ?? sr.productCategory ?? 'General sourcing request';
  // Replies stay possible after acceptance (payment / shipping questions) and
  // after a decline (a counter-offer is a new revision); the offer tab then
  // shows why the price is locked instead of a price form. A closed request
  // takes a new quote ("New quote for this buyer").
  const canCompose = !sr.archivedAt && sr.status !== 'CLOSED';
  const formCtx = await offerFormContextFor(sr, 'STAFF', `Emailed to ${sr.buyerEmail}.`);
  const baseForm = offerFormProps(sr, linkedOrder, formCtx);
  const offerForm = baseForm && {
    ...baseForm,
    brand,
    countries: (await countryOptions()).map((c) => ({ code: c.code, name: c.name })),
    listingUnpublished: sr.product && sr.product.status !== 'PUBLISHED' ? sr.product.status.toLowerCase().replace(/_/g, ' ') : null,
  };
  const priceLocked = priceLockedMessage(sr, linkedOrder);
  const dealOpen = sr.status === 'PENDING' || sr.status === 'RESPONDED';
  // The listed unit went elsewhere (sold, or held for another order): red in the hero, not only in the composer.
  const stockBad = dealOpen && formCtx.stock?.tone === 'bad' ? formCtx.stock.text : null;
  // Closing is for deals that went nowhere. An accepted deal is undone in the
  // Deal panel (cancel / refund), a paid order on the order page.
  const canClose = canStatus &&
    sr.status !== 'CLOSED' && sr.status !== 'DECLINED' && sr.status !== 'ACCEPTED' &&
    (!linkedOrder || linkedOrder.status === 'PENDING_PAYMENT' || linkedOrder.status === 'CANCELED');
  const canClone = canSendOffer && (sr.status === 'CLOSED' || (sr.status === 'ACCEPTED' && linkedOrder?.status === 'CANCELED'));
  const mailProblem = suppression
    ? `E-mails to ${sr.buyerEmail} are stopped since ${fmtWhen(suppression.createdAt)} (${suppression.reason === 'BOUNCE' ? 'the address bounced' : suppression.reason === 'COMPLAINT' ? 'spam complaint' : 'stopped by an admin'}). The buyer only sees this quote in their dashboard — ask for another address.`
    : lastMail && lastMail.status !== 'sent'
      ? `The last e-mail to ${sr.buyerEmail} was not delivered — “${lastMail.subject}”, ${fmtWhen(lastMail.createdAt)}: ${MAIL_NOT_SENT[lastMail.status] ?? lastMail.status}${lastMail.error ? ` (${lastMail.error.slice(0, 200)})` : ''}.`
      : null;

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <Link
        href="/admin/quotes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back to deals
      </Link>
      {/* Stuck-state warning: status=ACCEPTED but no linked order. Surfaces
          legacy quotes where admin replied with a text price and buyer
          clicked the (old) Accept button. New flow prevents this entirely
          (proforma-send is the order trigger) but legacy data may still
          present this state. */}
      {sr.status === 'ACCEPTED' && !linkedOrder && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-700 dark:text-red-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold text-red-900 dark:text-red-300">This quote is accepted but no order exists.</p>
            <p className="text-sm text-red-800 dark:text-red-300 mt-1">
              Legacy state: the quote was marked accepted without an order (acceptance now
              always creates the order and the proforma in one step). Send the buyer an offer
              on a new request instead.
            </p>
          </div>
        </div>
      )}
      {mailProblem && (
        <div role="alert" className="rounded-2xl border-2 border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 p-4 flex items-start gap-3 text-sm text-red-900 dark:text-red-300" data-testid="quote-mail-failed">
          <MailWarning className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <p className="min-w-0 [overflow-wrap:anywhere]">
            {mailProblem}{' '}
            <Link href="/admin/settings/security/email" className="font-semibold underline">E-mail log</Link>
          </p>
        </div>
      )}
      {/* ============ HERO: amount + deal state + ownership ============ */}
      <div className={`rounded-2xl border-2 bg-card overflow-hidden ${dealTone.ring} ring-1 ring-inset`}>
        <div className="p-6 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-[11px] text-muted-foreground">{quoteRef}</span>
              {sr.proformaNumber && (
                <span className="font-mono text-[11px] text-muted-foreground" title="Proforma of the accepted offer">· {sr.proformaNumber}</span>
              )}
              {priorityChip(sr.priority)}
              {sr.customerType === 'GUEST' && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-muted text-muted-foreground border border-border px-1.5 py-0.5">
                  guest
                </span>
              )}
              {sr.archivedAt && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-muted text-muted-foreground border border-border px-1.5 py-0.5">
                  archived
                </span>
              )}
            </div>
            <h1 dir="auto" className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 inline-flex items-center gap-1.5 flex-wrap min-w-0">
              <span dir="auto" className="font-medium text-foreground">{sr.buyerName}</span>
              <span>·</span>
              <EmailText email={sr.buyerEmail} className="hover:text-foreground" asLink />
              {sr.companyName && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {sr.companyName}</span>
                </>
              )}
            </p>

            {/* Funnel stepper */}
            <div className="mt-5">
              <DealStepper badge={deal} />
            </div>
          </div>

          {/* Right rail of hero — DOMINANT amount */}
          <div className="flex flex-col items-end gap-3 min-w-0">
            <div className="text-right min-w-0">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                {sr.status === 'ACCEPTED' ? 'Accepted amount' : sr.status === 'DECLINED' || sr.status === 'CLOSED' ? (sr.quotedPriceCents ? 'Last offer (void)' : 'No deal') : sr.quotedPriceCents ? (offerCard?.amounts.vatDecided ? 'Offer incl. VAT' : 'Offer excl. VAT') : 'No offer yet'}
              </p>
              {sr.quotedPriceCents ? (
                <p className={`text-4xl font-bold tabular-nums tracking-tight leading-none mt-1 ${
                  deal.state === 'won_paid' ? 'text-emerald-700 dark:text-emerald-300'
                    : deal.state.startsWith('won_') ? 'text-purple-700 dark:text-purple-300'
                    : deal.state.startsWith('lost_') ? 'text-muted-foreground line-through'
                    : 'text-foreground'
                }`}>
                  {offerCard ? fmtMoney(offerCard.amounts.totalCents, offerCard.currency) : fmtMoney(sr.quotedPriceCents, sr.quotedCurrency ?? 'EUR')}
                </p>
              ) : (
                <p className="text-2xl text-muted-foreground italic mt-1">—</p>
              )}
              {sr.quotedPriceCents != null && (
                <p className="text-[10px] text-muted-foreground mt-1 [overflow-wrap:anywhere]">
                  {sr.status === 'ACCEPTED'
                    ? payState === 'paid' ? `${invoiceNumber ? `Invoice ${invoiceNumber}` : sr.proformaNumber ?? ''} · paid`
                      : payState === 'terms' ? `Invoice ${invoiceNumber ?? ''} · on NET terms`
                      : payState === 'canceled' ? 'Order canceled · no payment due'
                      : payState === 'refunded' ? 'Order refunded'
                      : `${sr.proformaNumber ?? 'Proforma'}${partPaid ? ` · ${partPaid}` : ''}${linkedOrder?.dueAt ? ` · payment due ${fmtDueDate(linkedOrder.dueAt)}` : ''}`
                    : sr.status === 'DECLINED' || sr.status === 'CLOSED'
                      ? `${sr.status === 'DECLINED' ? 'Declined by the buyer' : 'Closed'}${sr.lostReason ? ` — ${sr.lostReason}` : ''}`
                      : sr.validUntilAt ? `${sr.validUntilAt.getTime() < Date.now() ? 'expired' : 'valid until'} ${fmtDueDate(sr.validUntilAt)}` : ''}
                </p>
              )}
            </div>
            <DealStateBadge badge={deal} />
            {stockBad && (
              <p className="max-w-full text-right text-[11px] font-semibold rounded-lg border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 px-2.5 py-1.5 inline-flex items-start gap-1.5 [overflow-wrap:anywhere]" data-testid="quote-hero-stock">
                <Package className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> {stockBad}
              </p>
            )}
            <AssigneeBadge
              quoteId={sr.id}
              assignee={sr.assignedTo}
              myUserId={session?.user.id ?? null}
              admins={admins}
              variant="block"
              canAssign={canAssign}
            />
            <QuoteHeaderControls
              quoteId={sr.id}
              priority={sr.priority}
              archived={!!sr.archivedAt}
              canClose={canClose}
              closeReasons={settingList('QUOTE_CLOSE_REASONS')}
              autoArchive={autoArchiveOnClose()}
              hasOpenOffer={offerCard?.phase === 'open' || offerCard?.phase === 'expired'}
              canSetPriority={canStatus}
              canArchive={canArchive}
              canClone={canClone}
            />
            {linkedOrder && (invoiceNumber || (sr.proformaNumber && linkedOrder.status === 'PENDING_PAYMENT')) && (
              <div className="flex items-center gap-1.5">
                <a
                  href={documentHref(invoiceNumber ? 'invoice' : 'proforma', linkedOrder.orderNumber, 'pdf')}
                  className="inline-flex items-center gap-1 h-9 px-3 rounded-full border border-border bg-card text-xs font-bold hover:bg-foreground/5"
                >
                  <FileText className="h-3.5 w-3.5" /> {invoiceNumber ? `Invoice ${invoiceNumber}` : 'Proforma PDF'}
                </a>
                <a
                  href={documentHref(invoiceNumber ? 'invoice' : 'proforma', linkedOrder.orderNumber, 'preview')}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center h-9 px-3 rounded-full text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  Preview
                </a>
              </div>
            )}
            {linkedOrder && (
              <Link
                href={`/admin/orders/${linkedOrder.id}`}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/40 text-xs font-bold hover:bg-emerald-100"
              >
                Open order {linkedOrder.orderNumber}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
      </div>
      {/* ============ MAIN: conversation-centric + sidebar ============ */}
      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        {/* LEFT — original request, conversation, composer */}
        <div className="space-y-4 min-w-0">
          <section className="rounded-2xl border border-border bg-card p-5">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2 inline-flex items-center gap-1">
              <FileText className="h-3 w-3" /> Original request
            </p>
            <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{sr.description}</p>
            {(sr.budget || sr.timeframe || sr.productCategory) && (
              <div className="mt-3 grid sm:grid-cols-3 gap-3 text-xs">
                {sr.budget && <Stat label="Budget" value={sr.budget} />}
                {sr.timeframe && <Stat label="Timeframe" value={sr.timeframe} />}
                {sr.productCategory && <Stat label="Category" value={sr.productCategory} />}
              </div>
            )}
          </section>

          {/* The offer as the buyer sees it (same totals as the order). */}
          {offerCard && <OfferCard {...offerCard} />}
          {sr.sellerProposalStatus === 'PENDING' && (
            <section className="rounded-2xl border-2 border-sky-300 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 p-4 text-sm space-y-1" data-testid="admin-proposal-pending">
              <p className="font-bold">Supplier proposal waiting for review: {fmtMoney(sr.sellerProposalCents ?? 0, sr.sellerProposalCurrency ?? 'EUR')} excl. VAT</p>
              <p className="text-xs text-muted-foreground">The buyer has not seen an offer yet. Open the composer below → “Offer”: the suggested buyer price (margin from Settings) is ready to use. Sending the offer approves the proposal.</p>
              {canSendOffer && <SellerProposalReject quoteId={sr.id} />}
            </section>
          )}

          {/* Conversation — the HERO of the workspace */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider">Negotiation</h2>
              <span className="text-xs text-muted-foreground">{`${sr.messages.length} message${sr.messages.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="p-5 space-y-3 max-h-[760px] overflow-y-auto bg-foreground/[0.02]">
              {sr.messages.length === 0 ? (
                <div className="rounded-xl border-2 border-dashed border-border bg-card p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
                    Lifecycle so far
                  </p>
                  <ActivityTimeline events={timeline} />
                </div>
              ) : (
                <ul className="space-y-3">
                  {sr.messages.map((m) => (
                    <li key={m.id}>
                      <div
                        className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                          m.isInternalNote
                            ? 'bg-amber-50 border border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300 mx-auto w-full max-w-[92%]'
                            : m.fromStaff
                            ? 'bg-primary text-primary-foreground ml-auto'
                            : 'bg-card border border-border'
                        }`}
                      >
                        <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1 [overflow-wrap:anywhere]">
                          {m.isInternalNote
                            ? `Internal note · ${m.author?.name ?? m.author?.email ?? 'staff'}`
                            // Our side by brand ("Labtodate · Anna"), the supplier as "Supplier · …".
                            : messageAuthorLabel(m, { kind: 'STAFF', userId: '', brand, buyerName: sr.buyerName })}
                          {' · '}
                          {fmtWhen(m.createdAt)}
                        </p>
                        <p dir="auto" className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{m.body}</p>
                        <MessageAttachments urls={m.attachments} names={m.attachmentNames} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Composer — collapsed by default; expands to compose */}
          {canCompose && (
            <QuoteComposer
              quoteId={sr.id}
              buyerEmail={sr.buyerEmail}
              offer={offerForm}
              priceLocked={priceLocked}
              canReply={canReply}
              canSendOffer={canSendOffer}
              quotationHref={quotationHref}
            />
          )}
        </div>

        {/* RIGHT — sidebar: customer intelligence, linked commerce, activity, magic-link */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto pb-6 min-w-0">
          <BuyerIntelCard
            intel={intel}
            buyerName={sr.buyerName}
            buyerEmail={sr.buyerEmail}
            company={sr.submittedBy?.company?.name ?? sr.companyName ?? null}
            isGuest={sr.customerType === 'GUEST'}
          />

          {/* Linked commerce — product anchor + accepted order */}
          <SidebarCard title="Linked commerce" icon={<ShoppingBag className="h-3.5 w-3.5 text-primary" />}>
            {sr.product && (
              <p className="text-[11px] mb-2">
                <span className="text-muted-foreground">Product · </span>
                <Link href={`/marketplace/${sr.product.slug}`} className="font-semibold hover:text-primary inline-flex items-center gap-1">
                  {sr.product.title} <ExternalLink className="h-3 w-3" />
                </Link>
              </p>
            )}
            {linkedOrder && dealStage ? (
              <QuoteDealPanel
                orderId={linkedOrder.id}
                orderNumber={linkedOrder.orderNumber}
                stage={dealStage}
                totalLabel={fmtMoney(linkedOrder.totalCents, linkedOrder.currency)}
                statusLabel={
                  payState === 'terms' ? 'approved on invoice terms'
                    : payState === 'review' ? 'receipt to verify'
                    : dealStage === 'PART_PAID' ? 'part paid'
                    : linkedOrder.status.toLowerCase().replace(/_/g, ' ')
                }
                dueLabel={linkedOrder.status === 'PENDING_PAYMENT' && linkedOrder.dueAt ? `Payment due ${fmtDueDate(linkedOrder.dueAt)}` : null}
                receivedLabel={partPaid}
                canRefund={canRefund}
              />
            ) : sr.quotedPriceCents && offerCard ? (
              <p className="text-[11px]">
                {offerCard.phase === 'open' || offerCard.phase === 'expired'
                  ? <>Offer {offerCard.phase === 'expired' ? 'expired' : 'sent'}: <strong>{fmtMoney(offerCard.amounts.totalCents, offerCard.currency)}</strong>{offerCard.amounts.vatDecided ? '' : ' excl. VAT'} — no order until the buyer accepts.</>
                  : <>No deal — the offer of {fmtMoney(offerCard.amounts.totalCents, offerCard.currency)} is void.</>}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">No offer or order yet.</p>
            )}
            {sr.offerSupplierCostCents != null && offerCard && (
              <p className="text-[11px] mt-1.5 text-muted-foreground">
                Supplier price {fmtMoney(sr.offerSupplierCostCents, offerCard.currency)} · margin {fmtMoney(offerCard.amounts.goodsCents - sr.offerSupplierCostCents, offerCard.currency)} (internal)
              </p>
            )}
            {credit && credit.approved && (
              <p className="text-[11px] mt-1.5 text-muted-foreground">Buyer credit: NET {credit.termDays}, {fmtMoney(credit.availableCents, 'EUR')} of {fmtMoney(credit.limitCents, 'EUR')} available{credit.enabled ? '' : ' (invoice payment is off in Settings)'}.</p>
            )}
            {sr.customerType === 'GUEST' && canReply && <QuoteReissueMagicLink quoteId={sr.id} />}
          </SidebarCard>

          {/* Activity log */}
          <SidebarCard title="Activity" icon={<Hourglass className="h-3.5 w-3.5 text-primary" />}>
            <ActivityTimeline events={timeline} />
          </SidebarCard>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="font-bold text-sm mt-0.5 [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

function SidebarCard({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1">
        {icon}{title}
      </p>
      {children}
    </div>
  );
}
