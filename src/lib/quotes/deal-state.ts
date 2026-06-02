/**
 * Unified deal state — the SINGLE operational truth for a SourcingRequest.
 *
 * The DB has 3 axes (status enum, lastReplyByStaff bool, proformaNumber)
 * + the linked Order's payment status. Surfacing all of these as separate
 * pills makes the queue feel flat ("PENDING + AWAITING REPLY + SUPPLIER REPLIED"
 * showing simultaneously). A procurement operator only cares about ONE
 * question: whose move is it, and where is this deal in the funnel?
 *
 * This module is the canonical mapping. Both queue rows and the detail page
 * read from here so the language stays consistent everywhere.
 */

export type DealState =
  | 'awaiting_supplier'      // PENDING and no staff reply yet
  | 'awaiting_buyer'         // staff has replied, waiting on buyer
  | 'proforma_sent'          // proforma issued, deal in buyer's court
  | 'won_payment_pending'    // accepted, order created, awaiting payment
  | 'won_paid'               // accepted + order paid
  | 'won_no_order'           // accepted but no order row (legacy / edge)
  | 'lost_declined'          // buyer DECLINED
  | 'lost_closed'            // seller / admin CLOSED without an accept
  | 'unknown';

export type DealTone = 'amber' | 'sky' | 'emerald' | 'purple' | 'red' | 'slate';

export interface DealStateBadge {
  state: DealState;
  label: string;
  /** UI hint for color family. */
  tone: DealTone;
  /** Lower = more operationally urgent (used as a sort tiebreaker). */
  weight: number;
  /** Funnel stage 1..5: submitted → qualified → quoted → paying → done. */
  funnelStep: 1 | 2 | 3 | 4 | 5;
}

export function computeDealState(sr: {
  status: string;
  lastReplyByStaff: boolean;
  proformaNumber: string | null;
  linkedOrder?: { status: string } | null;
}): DealStateBadge {
  const lo = sr.linkedOrder;

  // Closed / lost branches first — terminal states.
  if (sr.status === 'DECLINED') {
    return { state: 'lost_declined', label: 'Lost · declined by buyer', tone: 'red', weight: 9, funnelStep: 3 };
  }
  if (sr.status === 'CLOSED') {
    return { state: 'lost_closed', label: 'Closed', tone: 'slate', weight: 9, funnelStep: 3 };
  }

  // Order-state takes precedence over SR.status. If the linked Order is past
  // PENDING_PAYMENT the deal is effectively won — even if the SR row was
  // never bumped to ACCEPTED (legacy data / old admin verifyPayment that
  // didn't propagate). Without this the buyer's "My quotes" kept showing
  // "Proforma sent · awaiting decision" months after the order shipped.
  if (lo) {
    const paidLike = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
    if (paidLike.includes(lo.status)) {
      return { state: 'won_paid', label: 'Won · paid', tone: 'emerald', weight: 0, funnelStep: 5 };
    }
    if (lo.status === 'CANCELED' || lo.status === 'REFUNDED') {
      return { state: 'lost_closed', label: 'Lost · order canceled', tone: 'slate', weight: 9, funnelStep: 3 };
    }
    if (lo.status === 'PENDING_PAYMENT') {
      return { state: 'won_payment_pending', label: 'Awaiting your payment', tone: 'purple', weight: 1, funnelStep: 4 };
    }
  }

  if (sr.status === 'ACCEPTED') {
    return { state: 'won_no_order', label: 'Accepted · no order', tone: 'emerald', weight: 2, funnelStep: 4 };
  }

  // Active negotiation.
  if (sr.proformaNumber && sr.status === 'RESPONDED') {
    return { state: 'proforma_sent', label: 'Proforma sent · awaiting decision', tone: 'sky', weight: 3, funnelStep: 3 };
  }
  if (sr.lastReplyByStaff) {
    return { state: 'awaiting_buyer', label: 'Waiting for buyer', tone: 'sky', weight: 4, funnelStep: 2 };
  }
  return { state: 'awaiting_supplier', label: 'Waiting for supplier', tone: 'amber', weight: 5, funnelStep: 1 };
}

export function toneClasses(tone: DealTone): { pill: string; dot: string; ring: string } {
  switch (tone) {
    case 'amber':   return { pill: 'bg-amber-50 text-amber-900 border-amber-200',         dot: 'bg-amber-500',   ring: 'ring-amber-200' };
    case 'sky':     return { pill: 'bg-sky-50 text-sky-900 border-sky-200',               dot: 'bg-sky-500',     ring: 'ring-sky-200' };
    case 'emerald': return { pill: 'bg-emerald-50 text-emerald-900 border-emerald-200',   dot: 'bg-emerald-500', ring: 'ring-emerald-200' };
    case 'purple':  return { pill: 'bg-purple-50 text-purple-900 border-purple-200',      dot: 'bg-purple-500',  ring: 'ring-purple-200' };
    case 'red':     return { pill: 'bg-red-50 text-red-900 border-red-200',               dot: 'bg-red-500',     ring: 'ring-red-200' };
    case 'slate':   return { pill: 'bg-slate-100 text-slate-700 border-slate-200',        dot: 'bg-slate-400',   ring: 'ring-slate-200' };
  }
}
