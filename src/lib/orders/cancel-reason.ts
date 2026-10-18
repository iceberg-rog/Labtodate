/**
 * Why a canceled order was canceled, in the buyer's words (payment page and
 * order page). Pure: built from the quote's lost reason / note, the order's
 * admin notes and the void reason of its proforma — never a generic "the deal
 * was closed" when the real reason is known.
 */
export interface CancelReasonInput {
  quote: { status: string; lostReason: string | null; lostNote: string | null } | null;
  adminNotes?: string | null;
  /** voidReason of the last proforma ("Order canceled: …"). */
  proformaVoidReason?: string | null;
}

const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

export function buyerCancelExplanation(i: CancelReasonInput): { title: string; detail: string | null } {
  const lost = i.quote?.lostReason ?? '';
  const note = i.quote?.lostNote?.trim() || null;
  const voidWhy = i.proformaVoidReason?.replace(/^Order canceled:\s*/i, '').trim() || null;
  if (i.quote?.status === 'DECLINED') {
    return { title: 'You declined the offer, so this order was canceled.', detail: null };
  }
  if (/^Canceled by the buyer/i.test(lost) || (!lost && i.adminNotes?.includes('Canceled by the buyer'))) {
    const why = lost.replace(/^Canceled by the buyer:?\s*/i, '').trim();
    return { title: 'You canceled this order.', detail: why ? sentence(`Reason: ${why}`) : null };
  }
  if (/^Not paid by the due date/i.test(lost) || /^Not paid by the due date/i.test(voidWhy ?? '')) {
    return { title: 'This order was canceled because it was not paid in time.', detail: voidWhy ? sentence(voidWhy) : null };
  }
  // Staff cancel ("Canceled by <site name> after acceptance") — whatever the brand is called.
  if (/^Canceled by /i.test(lost)) {
    return { title: 'Our team canceled this order.', detail: note ? sentence(`Reason: ${note}`) : voidWhy ? sentence(`Reason: ${voidWhy}`) : null };
  }
  if (i.quote?.status === 'CLOSED') {
    // The close reason staff picked ("Bought elsewhere") and their note — never a generic "Closed by …".
    const reason = lost && !/^Closed by /i.test(lost) ? lost : null;
    const why = [reason, note].filter(Boolean).join(' — ');
    return { title: 'The quote was closed, so this order was canceled.', detail: why ? sentence(`Reason: ${why}`) : null };
  }
  return { title: 'This order was canceled.', detail: voidWhy ? sentence(`Reason: ${voidWhy}`) : null };
}
