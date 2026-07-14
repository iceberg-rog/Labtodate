import { headers } from 'next/headers';

// Simple in-memory sliding window. Single standalone instance, so this is
// sufficient to stop form-spam bursts without external infra.
const buckets = new Map<string, { count: number; reset: number }>();

export async function clientIp(): Promise<string> {
  const h = await headers();
  // SECURITY: trust X-Real-IP first — our nginx sets it to $remote_addr (the
  // real TCP peer), which a client cannot forge. The LEFT-most X-Forwarded-For
  // entry IS attacker-controlled, so keying rate limits off it lets anyone
  // spoof a fresh IP per request and bypass every limit. Only fall back to the
  // RIGHT-most XFF hop (the one our proxy appended) when X-Real-IP is absent
  // (e.g. local dev without nginx).
  const real = (h.get('x-real-ip') || '').trim();
  if (real) return real;
  const parts = (h.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Throws a user-facing error if `key` exceeded `max` hits within `windowMs`.
 */
export async function rateLimit(bucket: string, max = 5, windowMs = 10 * 60_000): Promise<void> {
  const key = `${bucket}:${await clientIp()}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > max) {
    throw new Error('Too many submissions. Please wait a few minutes and try again.');
  }
}
