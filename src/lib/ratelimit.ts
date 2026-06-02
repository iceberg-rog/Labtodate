import { headers } from 'next/headers';

// Simple in-memory sliding window. Single standalone instance, so this is
// sufficient to stop form-spam bursts without external infra.
const buckets = new Map<string, { count: number; reset: number }>();

export function clientIp(): string {
  const h = headers();
  const fwd = h.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
}

/**
 * Throws a user-facing error if `key` exceeded `max` hits within `windowMs`.
 */
export function rateLimit(bucket: string, max = 5, windowMs = 10 * 60_000): void {
  const key = `${bucket}:${clientIp()}`;
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
