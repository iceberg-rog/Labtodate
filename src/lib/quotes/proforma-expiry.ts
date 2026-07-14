import { type PrismaClient } from '@prisma/client';

/**
 * Atomic proforma-expiry transition (sla-sweep). Closes an expired quote and
 * cancels its linked PENDING_PAYMENT order together — but ONLY if the buyer has
 * not submitted a payment proof. Fixes the interleaving where a proof landing
 * between an external check and the transaction let the quote close (→ Lost) and
 * expiry notifications fire while the order stayed PENDING_PAYMENT with proof.
 *
 * The proof check is INSIDE the transaction, after attempting the (guarded)
 * order cancel. Order.sourcingRequestId is @unique, so there is at most one
 * linked order, which serialises concurrent sweeps on its row lock:
 *  - buyer proof wins  → `proof-in-flight`: nothing changes (quote RESPONDED,
 *    order PENDING_PAYMENT), zero side effects;
 *  - expiry wins       → `expired`: order CANCELED + quote CLOSED commit together;
 *  - no linked order    → `expired`: the quote still closes;
 *  - overlapping sweep  → `lost-race`: the guarded RESPONDED→CLOSED claim means
 *    only one sweep gets `expired`, so side effects fire exactly once (and only
 *    after the transaction commits).
 */

class ProofInFlightError extends Error {}
class LostRaceError extends Error {}

export type ProformaExpiryOutcome = 'expired' | 'proof-in-flight' | 'lost-race';

export async function expireProformaTransition(
  db: PrismaClient,
  sourcingRequestId: string,
): Promise<ProformaExpiryOutcome> {
  try {
    await db.$transaction(async (tx) => {
      // Cancel the linked pending order that has NO proof (at most one row).
      await tx.order.updateMany({
        where: { sourcingRequestId, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
        data: { status: 'CANCELED' },
      });
      // If a linked order is STILL pending WITH proof, the buyer acted — abort so
      // neither the quote nor the order expires and no side effects fire.
      const proofPending = await tx.order.count({
        where: { sourcingRequestId, status: 'PENDING_PAYMENT', paymentSubmittedAt: { not: null } },
      });
      if (proofPending > 0) throw new ProofInFlightError();
      // Close the quote (guarded) — only the sweep that flips RESPONDED→CLOSED wins.
      const claim = await tx.sourcingRequest.updateMany({
        where: { id: sourcingRequestId, status: 'RESPONDED' },
        data: { status: 'CLOSED' },
      });
      if (claim.count !== 1) throw new LostRaceError();
    });
    return 'expired';
  } catch (e) {
    if (e instanceof ProofInFlightError) return 'proof-in-flight';
    if (e instanceof LostRaceError) return 'lost-race';
    throw e;
  }
}
