/**
 * Unified sell-submission state — mirror of quotes' deal-state. Same shape so
 * the admin cockpit can share visual primitives (stripe color, badge palette,
 * tone classes) between Quote requests and Sell submissions without copy-
 * paste drift.
 */

export type SellState =
  | 'awaiting_team'       // PENDING, nobody on staff has touched it yet
  | 'in_review'           // staff replied (asking questions / valuating), waiting on seller
  | 'accepted'            // we made an offer / accepted the item
  | 'declined'            // we said no
  | 'closed';             // archived without a deal

export type SellTone = 'amber' | 'sky' | 'emerald' | 'red' | 'slate';

export interface SellStateBadge {
  state: SellState;
  label: string;
  tone: SellTone;
  /** Lower = more urgent (used to sort the queue by attention need). */
  weight: number;
  /** Funnel stage 1..4: submitted → reviewing → accepted → onboarded. */
  funnelStep: 1 | 2 | 3 | 4;
}

export function computeSellState(s: {
  status: string;
  lastReplyByStaff?: boolean;
  messageCount?: number;
}): SellStateBadge {
  if (s.status === 'ACCEPTED') {
    return { state: 'accepted',     label: 'Accepted',                tone: 'emerald', weight: 1, funnelStep: 3 };
  }
  if (s.status === 'DECLINED') {
    return { state: 'declined',     label: 'Declined',                tone: 'red',     weight: 9, funnelStep: 3 };
  }
  if (s.status === 'CLOSED') {
    return { state: 'closed',       label: 'Closed',                  tone: 'slate',   weight: 9, funnelStep: 3 };
  }
  if (s.status === 'RESPONDED' || (s.lastReplyByStaff && (s.messageCount ?? 0) > 0)) {
    return { state: 'in_review',    label: 'Awaiting seller reply',   tone: 'sky',     weight: 4, funnelStep: 2 };
  }
  // Default — PENDING with no staff reply yet
  return {   state: 'awaiting_team', label: 'Awaiting team review',   tone: 'amber',   weight: 5, funnelStep: 1 };
}

export function sellToneClasses(tone: SellTone): { pill: string; stripe: string; ring: string } {
  switch (tone) {
    case 'amber':   return { pill: 'bg-amber-100 text-amber-900 border-amber-200',   stripe: 'before:bg-amber-400',  ring: 'ring-amber-200' };
    case 'sky':     return { pill: 'bg-sky-50 text-sky-900 border-sky-200',          stripe: 'before:bg-sky-400',    ring: 'ring-sky-200' };
    case 'emerald': return { pill: 'bg-emerald-50 text-emerald-900 border-emerald-200', stripe: 'before:bg-emerald-500', ring: 'ring-emerald-200' };
    case 'red':     return { pill: 'bg-red-50 text-red-900 border-red-200',          stripe: 'before:bg-red-400',    ring: 'ring-red-200' };
    case 'slate':   return { pill: 'bg-slate-100 text-slate-700 border-slate-200',   stripe: 'before:bg-slate-400',  ring: 'ring-slate-200' };
  }
}
