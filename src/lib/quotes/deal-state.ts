/**
 * Unified deal state — the SINGLE operational truth for a SourcingRequest.
 *
 * The DB has several axes (status enum, the offer price + validity,
 * lastReplyByStaff, proformaNumber) + the linked Order's payment status.
 * Surfacing all of these as separate pills makes the queue feel flat. Both
 * sides only care about ONE question: whose move is it, and where is this
 * deal in the funnel?
 *
 * This module is the canonical mapping. Queue rows, detail pages, the seller
 * inbox and the buyer's lists all read from here so the language stays the
 * same everywhere. Labels differ per viewer (the buyer reads "your payment",
 * staff read "awaiting payment") but the state is identical.
 *
 * Funnel: Submitted → Engaged → Offer → Accepted → Paid. "Accepted" only ever
 * appears once the BUYER accepted an offer — never because an offer was sent.
 */
import { offerPhase } from './offer';

export type DealState =
  | 'awaiting_supplier'      // no staff reply yet (or the buyer wrote last)
  | 'awaiting_buyer'         // staff replied in text, no offer yet
  | 'offer_sent'             // offer open, waiting for the buyer to accept/decline
  | 'offer_expired'          // offer lapsed before the buyer accepted
  | 'won_payment_pending'    // accepted → order created, awaiting payment
  | 'won_payment_review'     // accepted, buyer sent a payment proof to verify
  | 'won_paid'               // order paid (or further along)
  | 'won_no_order'           // accepted but no order row (legacy / edge)
  | 'lost_declined'          // buyer DECLINED
  | 'lost_closed'            // closed without a deal / order canceled
  | 'unknown';

export type DealTone = 'amber' | 'sky' | 'emerald' | 'purple' | 'red' | 'slate';
export type DealViewer = 'buyer' | 'staff';

export interface DealStateBadge {
  state: DealState;
  label: string;
  /** UI hint for color family. */
  tone: DealTone;
  /** Lower = more operationally urgent (used as a sort tiebreaker). */
  weight: number;
  /** Funnel stage 1..5: submitted → engaged → offer → accepted → paid. */
  funnelStep: 1 | 2 | 3 | 4 | 5;
}

const LABELS: Record<Exclude<DealState, 'unknown'>, { buyer: string; staff: string }> = {
  awaiting_supplier:   { buyer: 'Waiting for our reply',             staff: 'New — awaiting our reply' },
  awaiting_buyer:      { buyer: 'Reply received — your move',        staff: 'Replied — awaiting buyer' },
  offer_sent:          { buyer: 'Offer received — accept or decline', staff: 'Offer sent — awaiting buyer' },
  offer_expired:       { buyer: 'Offer expired — ask for a new one',  staff: 'Offer expired — send a new offer' },
  won_payment_pending: { buyer: 'Accepted — awaiting your payment',  staff: 'Accepted — awaiting payment' },
  won_payment_review:  { buyer: 'Accepted — payment being verified', staff: 'Accepted — payment proof to verify' },
  won_paid:            { buyer: 'Paid',                              staff: 'Won · paid' },
  won_no_order:        { buyer: 'Accepted',                          staff: 'Accepted · no order' },
  lost_declined:       { buyer: 'You declined',                      staff: 'Declined by buyer' },
  lost_closed:         { buyer: 'Closed',                            staff: 'Closed · no deal' },
};

function badge(
  state: Exclude<DealState, 'unknown'>,
  viewer: DealViewer,
  tone: DealTone,
  weight: number,
  funnelStep: DealStateBadge['funnelStep'],
  label?: string,
): DealStateBadge {
  return { state, label: label ?? LABELS[state][viewer], tone, weight, funnelStep };
}

export function computeDealState(
  sr: {
    status: string;
    lastReplyByStaff: boolean;
    proformaNumber: string | null;
    /** The open/accepted offer price (null = no offer sent yet). */
    quotedPriceCents?: number | null;
    /** Offer validity while RESPONDED; proforma due date once ACCEPTED. */
    validUntilAt?: Date | string | null;
    linkedOrder?: { status: string; paymentSubmittedAt?: Date | string | null; financialStatus?: string | null; paymentVerificationStatus?: string | null } | null;
    /**
     * BUG-019 (buyer-facing closure): pass the SR's archivedAt from BUYER
     * surfaces only. When ops archives a still-"waiting" RFQ, the buyer must
     * not read "Waiting for supplier" forever — we surface it as closed.
     * A buyer reply auto-unarchives (BUG-018) and the state comes back to
     * life. Admin surfaces deliberately do NOT pass this (they have their own
     * ARCHIVED badge and need the true operational state).
     */
    archivedAt?: Date | string | null;
  },
  viewer: DealViewer = 'staff',
): DealStateBadge {
  const lo = sr.linkedOrder ?? null;

  // Terminal states first.
  if (sr.status === 'DECLINED') return badge('lost_declined', viewer, 'red', 9, 3);
  if (sr.status === 'CLOSED') return badge('lost_closed', viewer, 'slate', 9, 3);

  // Money moved: the order's state wins over a stale quote status (legacy
  // quotes paid before the quote row was bumped to ACCEPTED).
  if (lo) {
    if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(lo.status)) {
      // Approved on invoice terms is a won deal, but NOT paid.
      if (lo.financialStatus === 'INVOICED_ON_TERMS' || lo.financialStatus === 'OVERDUE' || lo.financialStatus === 'PARTIALLY_PAID') {
        return badge('won_paid', viewer, 'sky', 1, 5, viewer === 'buyer' ? 'Approved · pay on invoice' : 'Won · on invoice terms (unpaid)');
      }
      return badge('won_paid', viewer, 'emerald', 0, 5);
    }
    if (lo.status === 'PENDING_PAYMENT' && lo.paymentVerificationStatus === 'TERMS_REQUESTED') {
      return badge('won_payment_review', viewer, 'purple', 1, 4, viewer === 'buyer' ? 'Accepted — invoice terms requested' : 'Accepted — invoice terms to approve');
    }
    if (lo.status === 'REFUNDED') {
      return badge('lost_closed', viewer, 'slate', 9, 5, viewer === 'buyer' ? 'Refunded' : 'Order refunded');
    }
    if (lo.status === 'PENDING_PAYMENT' && lo.paymentSubmittedAt) {
      return badge('won_payment_review', viewer, 'purple', 1, 4);
    }
    if (lo.status === 'PENDING_PAYMENT' && sr.status === 'ACCEPTED') {
      return badge('won_payment_pending', viewer, 'purple', 1, 4);
    }
    if (lo.status === 'CANCELED' && sr.status === 'ACCEPTED') {
      return badge('lost_closed', viewer, 'slate', 9, 4, viewer === 'buyer' ? 'Order canceled' : 'Accepted · order canceled');
    }
  }

  if (sr.status === 'ACCEPTED') return badge('won_no_order', viewer, 'emerald', 2, 4);

  // An offer is on the table (or was) — the buyer decides.
  const phase = offerPhase(
    { status: sr.status, quotedPriceCents: sr.quotedPriceCents ?? null, validUntilAt: sr.validUntilAt ?? null },
    lo,
  );
  if (phase === 'void') {
    // RESPONDED with a canceled legacy order: dead until staff sends a new offer.
    return badge('lost_closed', viewer, 'slate', 9, 3, viewer === 'buyer' ? 'Order canceled' : 'Offer void · order canceled');
  }
  if (phase === 'open') {
    // A buyer question on an open offer puts the ball back with staff.
    if (!sr.lastReplyByStaff && viewer === 'staff') {
      return badge('offer_sent', viewer, 'amber', 3, 3, 'Offer sent — buyer replied, your move');
    }
    return badge('offer_sent', viewer, 'sky', 3, 3);
  }
  if (phase === 'expired') return badge('offer_expired', viewer, 'amber', 3, 3);

  // BUG-019: archived while still in a "waiting" state → buyer-facing closure.
  if (sr.archivedAt) {
    return badge('lost_closed', viewer, 'slate', 9, 2, viewer === 'buyer' ? 'Closed by our team' : 'Archived');
  }
  if (sr.lastReplyByStaff) return badge('awaiting_buyer', viewer, 'sky', 4, 2);
  if (sr.status === 'RESPONDED') {
    // Staff replied before, the buyer wrote last → our move again.
    return badge('awaiting_supplier', viewer, 'amber', 5, 2, viewer === 'buyer' ? 'Waiting for our reply' : 'Buyer replied — your move');
  }
  return badge('awaiting_supplier', viewer, 'amber', 5, 1);
}

export function toneClasses(tone: DealTone): { pill: string; dot: string; ring: string } {
  switch (tone) {
    case 'amber':   return { pill: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',         dot: 'bg-amber-500',   ring: 'ring-amber-200 dark:ring-amber-800' };
    case 'sky':     return { pill: 'bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',               dot: 'bg-sky-500',     ring: 'ring-sky-200 dark:ring-sky-800' };
    case 'emerald': return { pill: 'bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',   dot: 'bg-emerald-500', ring: 'ring-emerald-200 dark:ring-emerald-800' };
    case 'purple':  return { pill: 'bg-purple-50 text-purple-900 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800',      dot: 'bg-purple-500',  ring: 'ring-purple-200 dark:ring-purple-800' };
    case 'red':     return { pill: 'bg-red-50 text-red-900 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',               dot: 'bg-red-500',     ring: 'ring-red-200 dark:ring-red-800' };
    case 'slate':   return { pill: 'bg-muted text-muted-foreground border-border',        dot: 'bg-slate-400',   ring: 'ring-border' };
  }
}
