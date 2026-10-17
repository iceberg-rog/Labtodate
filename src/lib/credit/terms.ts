import { prisma } from '@/lib/db';
import { creditTermsEnabled } from '@/lib/quotes/policy';
import { formatPrice } from '@/lib/utils';
import { LIVE_REFUND_STATUSES } from '@/lib/finance/held';

/**
 * Credit terms (B07 minimal). A buyer may pay on invoice (NET terms) only when
 * CREDIT_TERMS_ENABLED is on AND staff approved the buyer for credit with a
 * credit limit (BillingProfile.creditApproved / creditLimitCents /
 * creditTermDays). The limit covers every order of the buyer that is
 * invoiced on terms (or requested) and not paid yet. Limits are kept in EUR —
 * other currencies prepay. Server-internal; call ensureSettingsLoaded() first.
 */

export const CREDIT_CURRENCY = 'EUR';

export interface CreditStatus {
  enabled: boolean;
  approved: boolean;
  eligible: boolean;
  /** Why not (for the buyer / staff), or a one-line summary when eligible. */
  reason: string;
  termDays: number;
  limitCents: number;
  outstandingCents: number;
  availableCents: number;
}

/** Unpaid on-terms exposure of a buyer (optionally excluding one order). */
export async function creditOutstandingCents(userId: string, excludeOrderId?: string | null): Promise<number> {
  const rows = await prisma.order.findMany({
    where: {
      buyerId: userId,
      currency: CREDIT_CURRENCY,
      // A canceled / refunded order's invoice was credited: nothing is open on it.
      status: { notIn: ['CANCELED', 'REFUNDED'] },
      ...(excludeOrderId ? { NOT: { id: excludeOrderId } } : {}),
      OR: [
        { financialStatus: { in: ['INVOICED_ON_TERMS', 'OVERDUE', 'CREDIT_APPROVED'] } },
        { financialStatus: 'PARTIALLY_PAID', paymentMethodManual: 'INVOICE' },
        { status: 'PENDING_PAYMENT', paymentVerificationStatus: 'TERMS_REQUESTED' },
      ],
    },
    select: {
      totalCents: true, amountPaidCents: true,
      documents: { where: { kind: 'CREDIT_NOTE' }, select: { totalCents: true } },
      refunds: { where: { status: { in: [...LIVE_REFUND_STATUSES] } }, select: { amountCents: true } },
    },
  });
  // Open = total − paid − what credit notes canceled of the unpaid amount (credited minus what
  // went back as money) — the same receivable rule as the refund core (lib/fulfilment/rules.ts).
  return rows.reduce((s, r) => {
    const credited = -r.documents.reduce((a, d) => a + d.totalCents, 0);
    const refunded = r.refunds.reduce((a, x) => a + x.amountCents, 0);
    return s + Math.max(0, r.totalCents - r.amountPaidCents - Math.max(0, credited - refunded));
  }, 0);
}

export async function creditStatusFor(userId: string, amountCents: number, currency: string, opts: { excludeOrderId?: string | null } = {}): Promise<CreditStatus> {
  const enabled = creditTermsEnabled();
  const profile = await prisma.billingProfile.findUnique({
    where: { userId },
    select: { creditApproved: true, creditLimitCents: true, creditTermDays: true },
  });
  const approved = !!profile?.creditApproved && (profile.creditLimitCents ?? 0) > 0;
  const termDays = profile?.creditTermDays ?? 30;
  const limitCents = profile?.creditLimitCents ?? 0;
  const outstandingCents = approved ? await creditOutstandingCents(userId, opts.excludeOrderId) : 0;
  const availableCents = Math.max(0, limitCents - outstandingCents);
  const base = { enabled, approved, termDays, limitCents, outstandingCents, availableCents };
  if (!enabled) return { ...base, eligible: false, reason: 'Payment on invoice is not offered — please pay by bank transfer.' };
  if (!approved) return { ...base, eligible: false, reason: 'Payment on invoice is only available to business accounts approved for credit. Contact us to apply; until then, please pay by bank transfer.' };
  if (currency !== CREDIT_CURRENCY) return { ...base, eligible: false, reason: `Payment on invoice is available for ${CREDIT_CURRENCY} orders only.` };
  if (amountCents > availableCents) {
    return { ...base, eligible: false, reason: `This order exceeds your available credit (${formatPrice(availableCents, CREDIT_CURRENCY)} of ${formatPrice(limitCents, CREDIT_CURRENCY)} available). Please pay by bank transfer, or settle open invoices first.` };
  }
  return { ...base, eligible: true, reason: `Approved for payment on invoice: NET ${termDays}, ${formatPrice(availableCents, CREDIT_CURRENCY)} of ${formatPrice(limitCents, CREDIT_CURRENCY)} available.` };
}
