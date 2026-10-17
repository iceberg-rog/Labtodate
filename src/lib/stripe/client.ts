import Stripe from 'stripe';

let cached: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * Local test hook: STRIPE_API_BASE (server .env only) points the SDK at a
 * Stripe stand-in on THIS machine (http://127.0.0.1:<port>). Anything that is
 * not a loopback address is ignored, so a secret key can never be sent to a
 * third-party host through this setting. Unset in production.
 */
function localApiBase(): { host: string; port: number; protocol: 'http' | 'https' } | null {
  const raw = (process.env.STRIPE_API_BASE ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    const protocol = u.protocol === 'https:' ? 'https' : 'http';
    return { host: u.hostname, port: Number(u.port || (protocol === 'https' ? 443 : 80)), protocol };
  } catch {
    return null;
  }
}

/** Rebuilds if the secret key changed (admin can set it at runtime). */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    cached = null;
    cachedKey = null;
    return null;
  }
  const base = localApiBase();
  const cacheKey = `${key}|${base ? `${base.protocol}://${base.host}:${base.port}` : ''}`;
  if (cached && cachedKey === cacheKey) return cached;
  cached = new Stripe(key, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion, ...(base ?? {}) });
  cachedKey = cacheKey;
  return cached;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
