import { headers } from 'next/headers';
import { allowHit } from './security/throttle';

export async function clientIp(): Promise<string> {
  const h = await headers();
  return clientIpFrom(h);
}

/**
 * The client address of a request. SECURITY: trust X-Real-IP first — our
 * nginx sets it to $remote_addr (the real TCP peer), which a client cannot
 * forge. The LEFT-most X-Forwarded-For entry IS attacker-controlled, so keying
 * rate limits off it lets anyone spoof a fresh IP per request and bypass every
 * limit. Only fall back to the RIGHT-most XFF hop (the one our proxy appended)
 * when X-Real-IP is absent (e.g. local dev without nginx).
 */
export function clientIpFrom(h: Headers): string {
  const real = (h.get('x-real-ip') || '').trim();
  if (real) return real;
  const parts = (h.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Throws a user-facing error if `bucket` exceeded `max` hits within `windowMs`
 * for this client address. Counters live in Postgres (rate_limit_bucket), so
 * they survive restarts and are shared by every worker.
 */
export async function rateLimit(bucket: string, max = 5, windowMs = 10 * 60_000): Promise<void> {
  const { allowed } = await allowHit(`rl:${bucket}:${await clientIp()}`, max, windowMs);
  if (!allowed) {
    throw new Error('Too many submissions. Please wait a few minutes and try again.');
  }
}

/** Same as {@link rateLimit} for a key that is not per client address (e.g. per account). */
export async function rateLimitKey(key: string, max: number, windowMs: number): Promise<void> {
  const { allowed } = await allowHit(`rl:${key}`, max, windowMs);
  if (!allowed) {
    throw new Error('Too many submissions. Please wait a few minutes and try again.');
  }
}
