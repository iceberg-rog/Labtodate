import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Payments ledger (B06 groundwork): every amount actually received is one
 * Payment row, and Order.amountPaidCents is their sum. Record a payment in the
 * SAME transaction that marks the order paid when possible.
 */
export async function recordPayment(
  db: Prisma.TransactionClient | typeof prisma,
  p: {
    orderId: string;
    amountCents: number;
    currency: string;
    method: string;
    receivedAt?: Date;
    reference?: string | null;
    payerName?: string | null;
    proofKey?: string | null;
    source?: 'MANUAL' | 'STRIPE' | 'LEGACY';
    stripePaymentIntentId?: string | null;
    verifiedById?: string | null;
    note?: string | null;
  },
): Promise<void> {
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) return;
  await db.payment.create({
    data: {
      orderId: p.orderId,
      amountCents: p.amountCents,
      currency: p.currency,
      method: p.method,
      receivedAt: p.receivedAt ?? new Date(),
      reference: p.reference ?? null,
      payerName: p.payerName ?? null,
      proofKey: p.proofKey ?? null,
      source: p.source ?? 'MANUAL',
      stripePaymentIntentId: p.stripePaymentIntentId ?? null,
      verifiedById: p.verifiedById ?? null,
      note: p.note ? p.note.slice(0, 500) : null,
    },
  });
  await db.order.update({ where: { id: p.orderId }, data: { amountPaidCents: { increment: p.amountCents } } });
}
