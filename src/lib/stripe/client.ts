import Stripe from 'stripe';

let cached: Stripe | null = null;
let cachedKey: string | null = null;

/** Rebuilds if the secret key changed (admin can set it at runtime). */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    cached = null;
    cachedKey = null;
    return null;
  }
  if (cached && cachedKey === key) return cached;
  cached = new Stripe(key, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion });
  cachedKey = key;
  return cached;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
