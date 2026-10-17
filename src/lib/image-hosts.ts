/**
 * Which images go through the Next image optimizer (server-side fetch) and
 * which the browser loads directly.
 *
 * The optimizer only fetches our own /media/** (next.config.mjs, IMAGE_HOSTS,
 * inlined here as NEXT_PUBLIC_IMAGE_HOSTS at build time) — anything else would
 * answer 400. A photo on another host (e.g. a supplier URL an admin pasted
 * into a listing) is therefore rendered with `unoptimized`: the visitor's
 * browser fetches it, our server never does. Unsplash demo photos stay
 * optimized: nginx answers those /_next/image URLs from local copies.
 */
const OPTIMIZED_HOSTS = new Set(
  [...(process.env.NEXT_PUBLIC_IMAGE_HOSTS || '').split(','), 'images.unsplash.com']
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/** true = render with `unoptimized` (browser loads it directly). */
export function loadDirectly(src: string | null | undefined): boolean {
  if (!src || !/^https?:\/\//i.test(src)) return false; // relative /media/… goes through the rewrite
  try {
    return !OPTIMIZED_HOSTS.has(new URL(src).hostname.toLowerCase());
  } catch {
    return true;
  }
}
