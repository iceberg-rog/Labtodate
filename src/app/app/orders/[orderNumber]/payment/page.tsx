import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Banknote, CheckCircle2, XCircle, Clock,
  AlertTriangle, Upload, FileText, FileClock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { fmtDocMoney } from '@/lib/documents/render';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { DocumentButtons } from '@/components/documents/DocumentButtons';
import { documentNumberHref } from '@/lib/documents';
import { proformaNumberFor } from '@/lib/quotes/offer';
import { getOrderDocuments, issueProforma, snapshotOf } from '@/lib/documents/issue';
import { countryOptions } from '@/lib/compliance/country';
import { detailsSummary, orderDetailsProblems, prefillDetails } from '@/lib/orders/details';
import { cancelAfter, duePhase, effectiveDueDate, fmtDueDate } from '@/lib/orders/payment-due';
import {
  autoCancelUnpaid, buyerCanCancelUnpaid, cancelReasons, paymentGraceDays, paymentTermDays, requireDetailsBeforePayment, vatIdRule, verifyTurnaround,
} from '@/lib/quotes/policy';
import { creditStatusFor } from '@/lib/credit/terms';
import { pctLabel } from '@/lib/quotes/pricing';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { buyerSubmitPaymentProof } from './actions';
import { ProofFileInput } from './ProofFileInput';
import { buyerHoldMessages, hasPrePaymentHold } from '@/lib/checkout/holds';
import { availablePaymentMethods } from '@/lib/checkout/server';
import { CARD_FAIL_MESSAGE, type CardFailCode } from '@/lib/checkout/card';
import { payOrderByCard } from '@/lib/checkout/actions';
import { BuyerDetailsCard } from '@/components/orders/DetailsCards';
import { CancelOrderButton } from '@/components/orders/CancelOrderButton';
import { InvoiceTermsRequest } from '@/components/orders/InvoiceTermsRequest';
import { buyerCancelExplanation } from '@/lib/orders/cancel-reason';
import { heldMoneyCents, LIVE_REFUNDS_SELECT } from '@/lib/finance/held';
import { RECEIPT_TYPE_MESSAGE } from '@/lib/payments/receipts';
import { receiptHistory } from '@/lib/payments/rules';
import { proxyProofUrl } from '@/lib/orders/display';

export const dynamic = 'force-dynamic';

const ERR_MSG: Record<string, string> = {
  method: 'Please pick how you paid.',
  large: 'Receipt file must be under 8 MB.',
  type: RECEIPT_TYPE_MESSAGE,
  proofreq: 'Please attach the receipt file — we need it to find your transfer.',
  closed: 'This order is no longer accepting payment proof.',
  canceled: 'This order was canceled, so no payment is due. Please do not send a transfer for it.',
  expired: 'The payment deadline of this order has passed, so it can no longer be paid. Contact us or open a new request for a fresh offer.',
  notaccepted: 'Accept the offer first — the order is confirmed (and payable) only once you accept it.',
  details: 'Add your billing and delivery details first — we need them for the invoice and the delivery.',
  hold: 'This order is not payable yet: our team confirms the final total or checks the export rules for the delivery country first (see above). Nothing is due — please do not transfer money yet; we email you when you can pay.',
  terms: 'You asked to pay on invoice — our team is reviewing that request.',
  blocked: 'We cannot ship to that country. Nothing was submitted — please choose another delivery address or contact us.',
  countrychange: 'The delivery country cannot be changed while paying: it changes the shipping and VAT of this order. Nothing was submitted — contact us to change the destination.',
  review: 'Orders to that country are reviewed by our team before payment. Nothing was submitted — please contact us before transferring money.',
};

// Payment received — the order is past the "pay us" step.
const PAID_STATES: readonly string[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export default async function PaymentWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ ok?: string; err?: string; accepted?: string; mail?: string; card?: string }>;
}) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}/payment` });
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { orderNumber: orderNumber },
    include: {
      items: { select: { titleSnapshot: true, quantity: true, priceCentsSnapshot: true } },
      refunds: LIVE_REFUNDS_SELECT,
      paymentProofs: { select: { key: true, kind: true, fileName: true, amountCents: true, rejectedReason: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      payments: { select: { proofKey: true, amountCents: true } },
    },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  const sourcing = order.sourcingRequestId
    ? await prisma.sourcingRequest.findUnique({
        where: { id: order.sourcingRequestId },
        select: { id: true, status: true, validUntilAt: true, proformaNumber: true, proformaIssuedAt: true, companyName: true, buyerName: true, lostReason: true, lostNote: true },
      })
    : null;

  // Legacy: an order the OLD flow auto-created while the offer was never
  // accepted. It only becomes payable once the buyer accepts the offer.
  const notAccepted = !!sourcing && sourcing.status === 'RESPONDED' && order.status === 'PENDING_PAYMENT' && !order.paymentSubmittedAt;
  const verState = order.paymentVerificationStatus; // AWAITING_VERIFICATION | VERIFIED | REJECTED | TERMS_REQUESTED | TERMS_APPROVED | null
  const termsRequested = verState === 'TERMS_REQUESTED' && order.status === 'PENDING_PAYMENT';
  const onTerms = ['INVOICED_ON_TERMS', 'OVERDUE', 'CREDIT_APPROVED', 'PARTIALLY_PAID'].includes(order.financialStatus) && order.paymentMethodManual === 'INVOICE';
  // Pre-payment holds (shipping / VAT / compliance / address — lib/checkout/holds.ts):
  // not payable yet, no bank details / receipt / card. A payment that did not match
  // (Stripe) is being checked: never invite a second payment.
  const paymentReview = order.status === 'PENDING_PAYMENT' && (order.holdReason === 'PAYMENT_REVIEW' || order.openHolds.includes('PAYMENT_REVIEW'));
  const held = order.status === 'PENDING_PAYMENT' && (hasPrePaymentHold(order) || paymentReview);
  const openHoldCodes = new Set([...order.openHolds, ...(order.holdReason ? [order.holdReason] : [])]);
  const complianceOnly = openHoldCodes.size === 1 && openHoldCodes.has('COMPLIANCE');

  // ONE due date (A25): what the proforma prints, reminders and auto-cancel use.
  const now = new Date();
  const due = effectiveDueDate({ dueAt: order.dueAt, createdAt: order.createdAt, payableSince: order.payableSince, legacyValidUntil: sourcing?.validUntilAt ?? null }, paymentTermDays());
  const grace = paymentGraceDays();
  const autoCancel = autoCancelUnpaid();
  const phase = duePhase(now, due, grace);
  const cancelDate = cancelAfter(due, grace);
  const lapsed = autoCancel && phase === 'CANCEL_DUE' && order.status === 'PENDING_PAYMENT' && !order.paymentSubmittedAt;

  const quoteEnded = !!sourcing && (sourcing.status === 'DECLINED' || sourcing.status === 'CLOSED');
  const isVoid = lapsed || order.status === 'CANCELED' || (quoteEnded && order.status === 'PENDING_PAYMENT' && !order.paymentSubmittedAt) || notAccepted;
  const isPaid = !isVoid && PAID_STATES.includes(order.status) && !onTerms;
  const isRefunded = !isVoid && order.status === 'REFUNDED';
  const payable = !isVoid && order.status === 'PENDING_PAYMENT';

  // The proforma (payment request): issued at acceptance / on first view of a
  // checkout order; bank details, reference, amount and due date come from it.
  let docs = await getOrderDocuments(order.id);
  if (payable && !held && !docs.proforma && !notAccepted) {
    await issueProforma(order.id).catch(() => null);
    docs = await getOrderDocuments(order.id);
  }
  const pf = docs.proforma ? snapshotOf(docs.proforma) : null;
  const inv = docs.invoice ? snapshotOf(docs.invoice) : null;
  const lastPf = docs.proformaHistory.at(-1) ?? null;
  const lastCn = docs.creditNotes.at(-1) ?? null;
  // "Credited in full" only when the credit notes cover the whole invoice.
  const fullyCredited = !!docs.invoice && !!lastCn && docs.creditNotes.reduce((n, d) => n + Math.abs(d.totalCents), 0) >= Math.abs(docs.invoice.totalCents);
  const voidWhy = lapsed || notAccepted
    ? null
    : buyerCancelExplanation({ quote: sourcing, adminNotes: order.adminNotes, proformaVoidReason: lastPf?.voidReason ?? null });
  const proformaNumber = docs.proforma?.number ?? lastPf?.number ?? sourcing?.proformaNumber ?? (sourcing ? proformaNumberFor(sourcing.id, sourcing.proformaIssuedAt ?? order.createdAt) : order.orderNumber);
  const pfEmail = docs.proforma
    ? docs.proforma.sentAt
      ? { tone: 'ok' as const, text: `Emailed to you on ${fmtDueDate(docs.proforma.sentAt)}.` }
      : await (async () => {
          const failed = await prisma.emailLog.findFirst({ where: { subject: { contains: docs.proforma!.number }, status: { not: 'sent' } }, orderBy: { createdAt: 'desc' }, select: { error: true } });
          if (failed) return { tone: 'bad' as const, text: 'We could not email it to you — download it here.' };
          return Date.now() - docs.proforma!.createdAt.getTime() < 3 * 60_000 ? { tone: 'info' as const, text: 'It is being emailed to you now.' } : null;
        })()
    : null;

  const holdMsgs = held ? await buyerHoldMessages(order) : [];

  // Billing + delivery details (owner report 5): required before the receipt.
  const missing = orderDetailsProblems(order, { vatIdRule: vatIdRule() });
  const detailsRequired = requireDetailsBeforePayment();
  const detailsBlock = detailsRequired && missing.length > 0;
  const profile = await prisma.billingProfile.findUnique({
    where: { userId: session.user.id },
    select: { legalName: true, contactName: true, vatId: true, address: true, country: true, phone: true, invoiceEmail: true },
  });
  const prefill = prefillDetails({ billingAddress: order.billingAddress, shippingAddress: order.shippingAddress, poNumber: order.poNumber, invoiceEmail: order.invoiceEmail, profile, companyName: sourcing?.companyName, buyerName: sourcing?.buyerName ?? session.user.name });
  const countries = await countryOptions();
  const credit = payable && !held && !termsRequested && !order.paymentSubmittedAt ? await creditStatusFor(session.user.id, order.totalCents, order.currency, { excludeOrderId: order.id }) : null;
  // Holds (pre-payment / payment review), invoice-terms requests and a receipt in review: nothing to submit.
  const canSubmit = payable && !held && !termsRequested && verState !== 'AWAITING_VERIFICATION';
  // Money already received (and not refunded or approved to be refunded): the buyer can no
  // longer cancel online — it needs a refund (lib/finance/refunds.ts heldMoneyCents).
  const netReceived = heldMoneyCents(order.amountPaidCents, order.refunds);
  const canCancel = payable && !!sourcing && !order.paymentSubmittedAt && netReceived === 0 && buyerCanCancelUnpaid();
  // Buyers who can not cancel here (switched off, or a checkout order) are told how instead.
  const cancelHelp = payable && !canCancel && !order.paymentSubmittedAt && netReceived === 0 ? settingString('BUYER_CANCEL_DISABLED_TEXT').trim() : '';
  const referenceHint = settingString('BANK_REFERENCE_HINT').trim();
  // The receipts this buyer sent (staff-attached proofs are not listed).
  const myReceipts = receiptHistory({ proofs: order.paymentProofs, payments: order.payments, currentProofUrl: order.paymentProofUrl, verificationStatus: verState })
    .filter((r) => r.by === 'BUYER');
  const ok = sp.ok === '1';
  const err = sp.err && ERR_MSG[sp.err];
  const cardMsg = sp.card === 'canceled'
    ? 'The card payment was not completed. Nothing was charged — you can try again or pay by bank transfer.'
    : sp.card && sp.card in CARD_FAIL_MESSAGE ? CARD_FAIL_MESSAGE[sp.card as CardFailCode] : null;
  // Card (Stripe) for a payable order — also after our team released a hold.
  // Like a receipt, it needs the billing + delivery details first (the invoice
  // is issued the moment the card payment is confirmed).
  // Part paid by transfer: the rest is paid by transfer too (a card session charges the whole order).
  const partPaid = order.status === 'PENDING_PAYMENT' && netReceived > 0;
  const openCents = Math.max(0, order.totalCents - netReceived);
  const money2 = (c: number) => fmtDocMoney(c, order.currency);
  const cardAvailable = canSubmit && !detailsBlock && !partPaid && !order.paymentSubmittedAt && order.holdReason !== 'PAYMENT_REVIEW' && availablePaymentMethods().includes('STRIPE_CARD');
  const turnaround = verifyTurnaround();
  const bank = pf?.bank ?? null;
  const money = (c: number) => formatPrice(c, order.currency);

  return (
    <div className="container-px py-10 max-w-3xl mx-auto min-w-0">
      <Link href={`/app/orders/${order.orderNumber}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
        <ChevronLeft className="h-4 w-4" /> Back to order
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          {isVoid
            ? notAccepted ? 'Offer not accepted yet' : lapsed ? 'Payment deadline passed' : 'Order canceled'
            : isPaid ? 'Payment received'
            : isRefunded ? 'Order refunded'
            : onTerms ? 'Approved — pay on invoice'
            : termsRequested ? 'Invoice payment requested'
            : paymentReview ? 'Payment being checked'
            : held ? (complianceOnly ? 'Export check before payment' : 'Total being confirmed')
            : 'Complete your payment'}
        </h1>
        <p className="text-muted-foreground mt-1">
          Order <span className="font-mono font-semibold">{order.orderNumber}</span> ·{' '}
          <span className={isVoid || isRefunded ? 'font-semibold line-through' : 'font-semibold'}>{money(order.totalCents)}</span>
          {(isVoid || isRefunded) && <> · no payment due</>}
          {isPaid && <> · paid</>}
          {partPaid && <> · <span className="font-semibold" data-testid="part-paid">{money2(netReceived)} received, {money2(openCents)} still due</span></>}
          {payable && !held && !termsRequested && <> · <span className={phase === 'OPEN' ? '' : 'text-red-700 dark:text-red-400 font-semibold'} data-testid="pay-by">pay by {fmtDueDate(due)}</span></>}
        </p>
      </div>

      {held && (
        <div role="status" className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 mb-6 flex items-start gap-3" data-testid="payment-held">
          <AlertTriangle className="h-5 w-5 text-amber-700 dark:text-amber-300 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-amber-900 dark:text-amber-300 space-y-1 min-w-0 [overflow-wrap:anywhere]">
            <p className="font-bold">{paymentReview ? 'Your payment is being checked — please do not pay again' : 'Please do not pay yet — nothing is due'}</p>
            {holdMsgs.map((h) => (
              <p key={h.code}><span className="font-semibold">{h.title}:</span> {h.message}</p>
            ))}
            {!paymentReview && <p>We email you the final total and the payment details as soon as you can pay; the payment term starts then. Please do not transfer money before that.</p>}
          </div>
        </div>
      )}

      {sp.accepted === '1' && !isVoid && (
        <div role="status" className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4 mb-6 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-700 dark:text-emerald-300 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-emerald-900 dark:text-emerald-300 min-w-0">
            <p className="font-bold">Offer accepted — order {order.orderNumber} is confirmed.</p>
            <p className="mt-1">
              {held
                ? complianceOnly
                  ? 'Our team checks the export rules for the delivery country first — please do not pay yet. We email you the proforma invoice as soon as you can pay.'
                  : 'Our team confirms the final total first (see above) — please do not pay yet. We email you the proforma invoice as soon as you can pay.'
                : <>Your proforma invoice <span className="font-mono">{proformaNumber}</span> is ready below{pfEmail?.tone === 'ok' ? ' and was emailed to you' : pfEmail?.tone === 'info' ? ' and is being emailed to you' : ''}. Pay by bank transfer by <strong>{fmtDueDate(due)}</strong>, then upload your receipt.</>}
            </p>
          </div>
        </div>
      )}

      {notAccepted && sourcing && (
        <Banner tone="amber" icon={<AlertTriangle className="h-5 w-5" />} title="You haven’t accepted this offer yet.">
          Review the offer and accept it first — the order becomes payable only after you accept.
          <Link href={`/app/quotes/${sourcing.id}`} className="block w-fit mt-3 h-9 leading-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold">Review the offer</Link>
        </Banner>
      )}

      {isVoid && voidWhy && (
        <Banner tone="red" icon={<XCircle className="h-5 w-5" />} title={voidWhy.title}>
          {voidWhy.detail && <span className="block mb-1 [overflow-wrap:anywhere]" dir="auto" data-testid="cancel-reason">{voidWhy.detail}</span>}
          {inv && lastCn && fullyCredited
            ? <>No payment is due — invoice <span className="font-mono">{inv.number}</span> is credited in full by credit note <span className="font-mono">{lastCn.number}</span>; please don&apos;t send a transfer for it.</>
            : <>No payment is due — please don&apos;t send a transfer for this order{lastPf ? ` (proforma ${lastPf.number} is void)` : ''}.</>}{' '}
          If you already paid, contact support and we&apos;ll refund it.
          {sourcing && ' If you still need the item, ask us for a new offer.'}
          <div className="flex items-center gap-2 flex-wrap mt-3">
            {sourcing && <Link href={`/app/quotes/${sourcing.id}`} className="inline-flex items-center h-9 px-4 rounded-full border border-red-300 dark:border-red-800 bg-white dark:bg-transparent text-xs font-bold">View the quote</Link>}
            <Link href="/app/support" className="inline-flex items-center h-9 px-4 rounded-full text-xs font-bold hover:underline">Contact support</Link>
          </div>
        </Banner>
      )}

      {lapsed && (
        <Banner tone="red" icon={<XCircle className="h-5 w-5" />} title="The payment deadline has passed.">
          This order was payable until <strong>{fmtDueDate(due)}</strong> (plus {grace} day{grace === 1 ? '' : 's'} grace, until {fmtDueDate(cancelDate)}). It is being canceled — please don&apos;t send a transfer for it. If you already paid, contact support.
          {sourcing && <Link href={`/app/quotes/${sourcing.id}`} className="block w-fit mt-3 h-9 leading-9 px-4 rounded-full border border-red-300 dark:border-red-800 text-xs font-bold">Ask for a new offer</Link>}
        </Banner>
      )}

      {payable && !lapsed && phase === 'OVERDUE' && !order.paymentSubmittedAt && !held && !termsRequested && (
        <Banner tone="red" icon={<AlertTriangle className="h-5 w-5" />} title={`Payment was due on ${fmtDueDate(due)}.`}>
          {autoCancel
            ? <>Please pay now and upload the receipt. Without a payment or receipt by <strong>{fmtDueDate(cancelDate)}</strong> the order is canceled and the item goes back on sale.</>
            : <>Please pay now and upload the receipt, or contact us if you need more time.</>}
        </Banner>
      )}

      {/* (The compliance hold is explained in the "payment-held" banner above, with
          every other open hold — one banner, the buyer texts of Settings → Checkout.) */}

      {termsRequested && (
        <Banner tone="sky" icon={<FileClock className="h-5 w-5" />} title="You asked to pay on invoice.">
          Our team reviews the request. If approved, you receive the invoice with its due date — nothing is due until then. If not, you pay by bank transfer as below.
        </Banner>
      )}

      {onTerms && (
        <Banner tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} title={`Approved on invoice terms${inv ? ` — invoice ${inv.number}` : ''}.`}>
          No payment is needed now. {inv?.payment?.kind === 'DUE' && inv.payment.dueDate ? <>Pay <strong>{money(inv.totals.totalCents)}</strong> by <strong>{fmtDueDate(inv.payment.dueDate)}</strong>, quoting <span className="font-mono">{inv.number}</span>.</> : 'Your invoice states the due date.'}
          {order.financialStatus === 'PARTIALLY_PAID' && ` Received so far: ${money(order.amountPaidCents)}.`}
        </Banner>
      )}

      {payable && !isPaid && !isRefunded && verState === 'AWAITING_VERIFICATION' && (
        <Banner tone="sky" icon={<Clock className="h-5 w-5" />} title="Your receipt is being reviewed.">
          {turnaround ? `We verify it within ${turnaround} and email you.` : 'We email you once it is verified.'} You can upload a corrected receipt if anything needs attention.
        </Banner>
      )}

      {isPaid && (
        <Banner tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} title={verState === 'VERIFIED' ? 'Payment verified.' : 'Payment received.'}>
          {order.status === 'SHIPPED' ? 'Your order has shipped.' : order.status === 'DELIVERED' ? 'Your order was delivered.' : 'Your order is being prepared for shipping.'}{' '}
          No further payment is needed. <Link href={`/app/orders/${order.orderNumber}`} className="underline font-semibold">Track it</Link>.
        </Banner>
      )}

      {isRefunded && (
        <Banner tone="slate" icon={<CheckCircle2 className="h-5 w-5" />} title="This order was refunded.">
          No payment is due. Questions about the refund? <Link href="/app/support" className="underline font-semibold">Contact support</Link>.
        </Banner>
      )}

      {payable && verState === 'REJECTED' && (
        <Banner tone="amber" icon={<AlertTriangle className="h-5 w-5" />} title={partPaid ? `Part payment received — ${money2(openCents)} still due.` : 'Your receipt needs attention.'}>
          {order.paymentRejectionReason || 'Please upload a corrected receipt below.'}
        </Banner>
      )}

      {ok && (
        <div role="status" className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-3 mb-6 text-sm text-emerald-900 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> Receipt uploaded — {turnaround ? `we verify it within ${turnaround}.` : 'we verify it and email you.'}
        </div>
      )}
      {err && (
        <div role="alert" className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 mb-6 text-sm text-red-900 dark:text-red-300 flex items-center gap-2">
          <XCircle className="h-4 w-4 flex-shrink-0" /> {err}
        </div>
      )}

      {canSubmit && (
        <div className="mb-6 rounded-2xl border border-border bg-card p-4">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3">What happens next</p>
          <ol className="grid sm:grid-cols-4 gap-3 text-[12px]">
            <Step n={1} done={missing.length === 0}><strong>Billing &amp; delivery details</strong> {missing.length === 0 ? '— done.' : '— add them below.'}</Step>
            <Step n={2}><strong>Pay</strong> by bank transfer by {fmtDueDate(due)}, quoting {proformaNumber}.</Step>
            <Step n={3}><strong>Upload the receipt</strong> of your transfer.</Step>
            <Step n={4}>We <strong>verify</strong>{turnaround ? ` within ${turnaround}` : ''}, send the invoice &amp; ship.</Step>
          </ol>
        </div>
      )}

      {/* === Documents: the invoice once paid / on terms, else the proforma ===
          (no proforma while a pre-payment hold is open: it is not a payment request yet) */}
      {!notAccepted && (inv || ((docs.proforma || lastPf) && !held)) && (
        <section className="mb-6 rounded-2xl border border-border bg-card overflow-hidden" aria-label={inv ? 'Invoice' : 'Proforma invoice'} data-testid="payment-doc">
          <div className="flex items-center justify-between gap-3 px-4 py-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-primary/10 inline-flex items-center justify-center flex-shrink-0">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold leading-tight">
                  {inv ? 'Your invoice' : 'Your proforma invoice'}
                  {!inv && isVoid && <Badge variant="secondary" className="ml-2 align-middle">Void</Badge>}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <span className="font-mono">{inv ? inv.number : proformaNumber}</span>
                  {' · '}
                  <span className={!inv && isVoid ? 'line-through' : undefined}>{money(inv ? inv.totals.totalCents : pf?.totals.totalCents ?? order.totalCents)}</span>
                  {!inv && docs.proforma && docs.proforma.version > 1 && <> · revision {docs.proforma.version}</>}
                </p>
                {inv && lastCn && fullyCredited && (
                  <p className="text-[11px] mt-0.5 text-muted-foreground" data-testid="payment-doc-credit">
                    Credited in full by credit note <a href={documentNumberHref(lastCn.number, 'pdf')} className="font-mono font-semibold underline">{lastCn.number}</a> — nothing is due.
                  </p>
                )}
                {!inv && pfEmail && (
                  <p className={`text-[11px] mt-0.5 ${pfEmail.tone === 'bad' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}>{pfEmail.text}</p>
                )}
              </div>
            </div>
            {inv
              ? <DocumentButtons kind="invoice" orderNumber={order.orderNumber} size="sm" />
              : docs.proforma && !isVoid ? <DocumentButtons kind="proforma" orderNumber={order.orderNumber} size="sm" />
              : lastPf ? <a href={documentNumberHref(lastPf.number, 'pdf')} className="text-xs font-semibold underline">Archived copy (void)</a>
              : null}
          </div>
        </section>
      )}

      {/* === Billing & delivery details (no receipt needed) === */}
      {payable && !notAccepted && (
        <div className="mb-6">
          <BuyerDetailsCard
            orderNumber={order.orderNumber}
            prefill={prefill}
            countries={countries}
            homeCountry={settingString('TAX_HOME_COUNTRY') || 'NL'}
            vatIdRule={vatIdRule()}
            missing={missing}
            summary={detailsSummary(order)}
            editable={verState !== 'AWAITING_VERIFICATION'}
            lockedReason={verState === 'AWAITING_VERIFICATION' ? 'Your receipt is being verified, so the details are locked. Contact support if something must change.' : null}
          />
        </div>
      )}

      {cardMsg && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 mb-6 text-sm text-amber-900 dark:text-amber-200" role="status" data-testid="card-message">
          {cardMsg}
        </div>
      )}
      {cardAvailable && (
        <section className="rounded-2xl border border-border bg-card p-6 mb-6 flex items-center justify-between gap-4 flex-wrap" data-testid="pay-by-card">
          <div className="text-sm">
            <p className="font-bold">Pay by card</p>
            <p className="text-muted-foreground mt-0.5">Exactly {formatPrice(order.totalCents, order.currency)} on Stripe’s secure card page — confirmed immediately.</p>
          </div>
          <form action={payOrderByCard}>
            <input type="hidden" name="orderNumber" value={order.orderNumber} />
            <Button type="submit" className="rounded-full font-semibold">Pay {formatPrice(order.totalCents, order.currency)} by card</Button>
          </form>
        </section>
      )}

      {/* === Bank transfer instructions: exactly what the proforma says ===
          (only while there is something to pay: canSubmit excludes holds) */}
      {canSubmit && pf && (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 space-y-4 mb-6 min-w-0" data-testid="bank-details">
          <div className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">Bank transfer</h2>
          </div>
          {bank ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Beneficiary</dt><dd className="font-semibold [overflow-wrap:anywhere]">{bank.beneficiary}</dd>
              {bank.bankName && (<><dt className="text-muted-foreground">Bank</dt><dd className="font-semibold">{bank.bankName}</dd></>)}
              <dt className="text-muted-foreground">IBAN</dt><dd className="font-mono font-semibold select-all [overflow-wrap:anywhere]">{bank.iban}</dd>
              {bank.bic && (<><dt className="text-muted-foreground">SWIFT / BIC</dt><dd className="font-mono font-semibold select-all">{bank.bic}</dd></>)}
              <dt className="text-muted-foreground">Reference</dt><dd className="font-mono font-semibold select-all">{docs.proforma?.number ?? proformaNumber}</dd>
              <dt className="text-muted-foreground">Amount</dt><dd className="font-bold" data-testid="bank-amount">{partPaid ? <>{money2(openCents)} <span className="font-normal text-muted-foreground">still due (of {money2(pf.totals.totalCents)}; {money2(netReceived)} received)</span></> : money(pf.totals.totalCents)}</dd>
              <dt className="text-muted-foreground">Pay by</dt><dd className={`font-bold ${phase === 'OPEN' ? '' : 'text-red-700 dark:text-red-400'}`}>{fmtDueDate(due)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Our bank details are not on this proforma yet. Please contact support — we send you the transfer instructions by email.</p>
          )}
          <p className="text-xs text-muted-foreground border-t border-border pt-3">
            Quote <span className="font-mono font-semibold">{docs.proforma?.number ?? proformaNumber}</span> as the transfer reference. These are the details printed on your proforma{docs.proforma ? ` (issued ${fmtDueDate(docs.proforma.issueDate)})` : ''}.
          </p>
          {referenceHint && <p className="text-xs text-foreground [overflow-wrap:anywhere]" dir="auto" data-testid="reference-hint">{referenceHint}</p>}
        </section>
      )}

      {/* === Pay on invoice (approved credit customers only) === */}
      {canSubmit && credit?.eligible && !detailsBlock && (
        <div className="mb-6"><InvoiceTermsRequest orderNumber={order.orderNumber} termDays={credit.termDays} summary={credit.reason} /></div>
      )}
      {/* Approved for credit, but not for this order (another currency, over the limit): say why. */}
      {canSubmit && credit && credit.enabled && credit.approved && !credit.eligible && (
        <p className="mb-6 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground inline-flex items-start gap-2" data-testid="terms-unavailable">
          <FileClock className="h-4 w-4 mt-0.5 flex-shrink-0" /> <span><span className="font-semibold text-foreground">Pay on invoice is not available for this order.</span> {credit.reason}</span>
        </p>
      )}

      {/* === Upload the receipt === */}
      {canSubmit && (
        detailsBlock ? (
          <section className="rounded-2xl border border-dashed border-border bg-card p-4 sm:p-6 mb-6 text-sm text-muted-foreground" data-testid="upload-locked">
            <p className="font-bold text-foreground inline-flex items-center gap-2"><Upload className="h-4 w-4" /> Upload your receipt</p>
            <p className="mt-1">First add your billing and delivery details above (missing: {missing.join(', ')}). We need them to issue your invoice and to ship.</p>
          </section>
        ) : (
          <form action={buyerSubmitPaymentProof} encType="multipart/form-data" className="space-y-6 mb-6" data-testid="proof-form">
            <input type="hidden" name="orderNumber" value={order.orderNumber} />
            <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 space-y-4">
              <h2 className="text-lg font-bold inline-flex items-center gap-2"><Upload className="h-5 w-5 text-primary" /> Upload your receipt</h2>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">How did you pay?</span>
                <select name="method" defaultValue="BANK_TRANSFER" required className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm">
                  <option value="BANK_TRANSFER">Bank transfer (SEPA / wire)</option>
                  <option value="OTHER">Other (explain in the note)</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Receipt <span className="text-muted-foreground font-normal">(JPG / PNG / WEBP / PDF, max 8 MB)</span></span>
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <ProofFileInput />
                  <p className="text-xs text-muted-foreground mt-2">The bank&apos;s transfer confirmation.</p>
                </div>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Bank transfer reference <span className="text-muted-foreground font-normal">(optional)</span></span>
                <input name="bank_ref" maxLength={60} placeholder="e.g. the reference on your bank statement" className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Note <span className="text-muted-foreground font-normal">(optional)</span></span>
                <textarea name="note" rows={3} maxLength={500} placeholder="Anything we should know — split payment, accounts-payable contact…" className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
              </label>
            </section>
            <div className="flex items-center gap-3 flex-wrap">
              <Button type="submit" size="lg" className="rounded-2xl font-semibold">
                <Upload className="h-4 w-4" /> {verState === 'REJECTED' ? 'Resubmit receipt' : 'Submit receipt for verification'}
              </Button>
              {turnaround && <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Typical verification: {turnaround}.</span>}
            </div>
          </form>
        )
      )}

      {/* === Cancel (accepted, unpaid quote order) === */}
      {canCancel && (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 mb-6 space-y-2" data-testid="cancel-section">
          <h2 className="text-sm font-bold">Changed your mind?</h2>
          <p className="text-xs text-muted-foreground">Until you send a payment receipt you can cancel this order yourself. The proforma becomes void and nothing is due.</p>
          <div className="flex flex-wrap gap-2"><CancelOrderButton orderNumber={order.orderNumber} reasons={cancelReasons()} /></div>
        </section>
      )}

      {payable && partPaid && (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 mb-6 space-y-2" data-testid="cancel-blocked">
          <h2 className="text-sm font-bold">Changed your mind?</h2>
          <p className="text-xs text-muted-foreground">We already received {money2(netReceived)} for this order, so it can not be canceled online. <Link href="/app/support" className="underline font-semibold">Contact support</Link> — we cancel it and refund what you paid.</p>
        </section>
      )}

      {cancelHelp && (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 mb-6 space-y-2" data-testid="cancel-help">
          <h2 className="text-sm font-bold">Changed your mind?</h2>
          <p className="text-xs text-muted-foreground whitespace-pre-line [overflow-wrap:anywhere]" dir="auto">{cancelHelp}</p>
          <Link href="/app/support" className="inline-flex items-center h-9 px-4 rounded-full border border-border text-xs font-bold hover:bg-foreground/5">Contact support</Link>
        </section>
      )}

      {/* === Receipts you sent (each one stays viewable, also after a rejection) === */}
      {myReceipts.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-5 mb-6 min-w-0" data-testid="my-receipts">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Receipts you sent</p>
          <ul className="divide-y divide-border text-sm">
            {myReceipts.map((r) => {
              const href = proxyProofUrl(r.key);
              const what = r.status === 'REJECTED' ? `needed a correction${r.reason ? `: ${r.reason}` : ''}`
                : r.status === 'PART' ? `booked as a part payment${r.amountCents != null ? ` (${money2(r.amountCents)})` : ''}`
                : r.status === 'VERIFIED' ? `verified${r.amountCents != null ? ` (${money2(r.amountCents)})` : ''}`
                : r.status === 'AWAITING' ? 'being reviewed'
                : r.status === 'REPLACED' ? 'replaced by a newer receipt'
                : 'on file';
              return (
                <li key={r.key} className="py-2 flex items-start justify-between gap-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">
                    <span className="font-semibold">{r.fileName ?? 'Receipt'}</span>
                    <span className="text-muted-foreground"> · {r.at ? `sent ${fmtDueDate(r.at)} · ` : ''}{what}</span>
                  </span>
                  {href && <a href={href} target="_blank" rel="noreferrer" className="text-xs font-semibold underline flex-shrink-0">Open</a>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* === Order summary === */}
      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5 mt-8 min-w-0">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Items</p>
        <ul className="divide-y divide-border">
          {order.items.map((it, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">{it.titleSnapshot} × {it.quantity}</span>
              <span className="font-semibold tabular-nums flex-shrink-0">{money(it.priceCentsSnapshot * it.quantity)}</span>
            </li>
          ))}
        </ul>
        <dl className="border-t border-border pt-3 mt-3 space-y-1 text-sm">
          {order.shippingCents > 0 && <Row label="Freight / shipping" value={money(order.shippingCents)} />}
          <Row
            label={order.vatTreatment && order.vatTreatment !== 'LEGACY_UNSPECIFIED' && order.vatRateBp != null ? `VAT ${pctLabel(order.vatRateBp)} — ${vatTreatmentLabel(order.vatTreatment)}` : 'VAT'}
            value={money(order.taxCents)}
          />
          <div className="flex items-center justify-between text-base font-bold pt-1">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(order.totalCents)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function Banner({ tone, icon, title, children }: { tone: 'red' | 'amber' | 'sky' | 'emerald' | 'slate'; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const cls = {
    red: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-300',
    amber: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300',
    sky: 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-900 dark:text-sky-300',
    emerald: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300',
    slate: 'border-border bg-card text-foreground',
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 mb-6 flex items-start gap-3 ${cls}`} role="status">
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <div className="text-sm flex-1 min-w-0 [overflow-wrap:anywhere]">
        <p className="font-bold">{title}</p>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function Step({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`shrink-0 h-5 w-5 rounded-full inline-flex items-center justify-center text-[10px] font-bold ${done ? 'bg-emerald-600 text-white' : 'bg-primary text-primary-foreground'}`}>{done ? '✓' : n}</span>
      <span>{children}</span>
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground min-w-0">{label}</dt>
      <dd className="tabular-nums flex-shrink-0">{value}</dd>
    </div>
  );
}
