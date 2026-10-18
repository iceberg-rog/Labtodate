/**
 * What a supplier is told when their quote request passes its reply time.
 * The buyer stays anonymous to a supplier and the priority is internal, so
 * neither is an input: the request is named the way the supplier inbox
 * names it.
 */
export function sellerSlaNotice(
  q: { ref: string; productTitle?: string | null; productCategory?: string | null },
  overdue: string,
): { subject: string; title: string; body: string } {
  const subject = q.productTitle || q.productCategory || 'General sourcing request';
  return {
    subject,
    title: `A buyer is waiting · ${q.ref}`,
    body: `“${subject}” — reply time passed ${overdue} ago`,
  };
}
