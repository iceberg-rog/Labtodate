import type Stripe from 'stripe';
import type { StripeSessionApi } from '@/lib/orders/stripe-handoff';

/**
 * SAFE Checkout-session expire. NEVER classifies by error message (a legitimate
 * "cannot expire a Checkout Session that is complete" contains "expire"). On an
 * expire error we RETRIEVE the session and accept success ONLY when the
 * authoritative `status === 'expired'`. A complete/open/unknown status, or a
 * failed retrieval, FAILS CLOSED (re-throws) so the cancel saga returns
 * `expire-failed` and never cancels/restocks an order behind a live/paid session.
 */
export async function safeExpire(stripe: Stripe, sessionId: string): Promise<void> {
  try {
    await stripe.checkout.sessions.expire(sessionId);
    return;
  } catch (err) {
    let s: Stripe.Checkout.Session;
    try {
      s = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      throw err; // cannot confirm state → fail closed
    }
    if (s.status === 'expired') return; // authoritatively already expired → success
    throw err; // complete / open / unknown → fail closed
  }
}

/** Expire-only adapter (create() is never used for cancellation). */
export function expireOnlyApi(stripe: Stripe): StripeSessionApi {
  return {
    create: async () => {
      throw new Error('expireOnlyApi.create is not used');
    },
    expire: (id) => safeExpire(stripe, id),
  };
}

/**
 * Adapter for a signed `checkout.session.expired` event: that session is
 * authoritatively expired by the event itself, so expiring it is a no-op success;
 * any OTHER session id falls back to the retrieve-confirmed safeExpire.
 */
export function confirmedExpiredApi(stripe: Stripe, confirmedExpiredId: string): StripeSessionApi {
  return {
    create: async () => {
      throw new Error('confirmedExpiredApi.create is not used');
    },
    expire: async (id) => {
      if (id === confirmedExpiredId) return;
      await safeExpire(stripe, id);
    },
  };
}
