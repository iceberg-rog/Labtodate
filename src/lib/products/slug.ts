import { prisma } from '@/lib/db';

/**
 * Matching a product URL segment to the slug as it is STORED.
 *
 * Most slugs are plain `[a-z0-9-]`, but some imported listings kept the
 * source shop's percent-encoded slug literally, e.g.
 * `agilent-g1314-60086-standard-flow-cell-10-mm-14-%c2%b5l-for-vwd` ('µl').
 * A link to `/marketplace/<that slug>` never reaches the page spelled that way:
 * Next decodes the path segment and hands the App Router page the value
 * re-encoded with encodeURIComponent — upper-case hex ('%C2%B5') — and a link
 * that escaped the '%' (`%25c2%25b5`) arrives as `%25c2%25b5`. An exact
 * `findUnique({ slug: params.slug })` therefore 404s on every spelling.
 */

const PCT = /%[0-9a-f]{2}/gi;

function decodeOnce(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // a stray '%' that is not an escape
  }
}

/** Every spelling the stored slug may have for this URL segment, the literal one first. */
export function productSlugCandidates(param: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    out.add(s);
    out.add(s.replace(PCT, (m) => m.toLowerCase()));
    out.add(s.replace(PCT, (m) => m.toUpperCase()));
  };
  add(param);
  // Decoded once ('%25c2' → '%c2') and fully ('%C2%B5' → 'µ'), then that
  // decoded text re-encoded the way an importer would have stored it.
  let s = param;
  for (let i = 0; i < 2; i++) {
    const d = decodeOnce(s);
    if (d === null || d === s) break;
    add(d);
    s = d;
  }
  add(encodeURIComponent(s));
  return [...out];
}

/**
 * The stored slug a product URL segment refers to — `param` itself when it is
 * a plain slug (no extra query) or when nothing matches (the caller's lookup
 * then 404s as before).
 */
export async function resolveProductSlug(param: string): Promise<string> {
  const candidates = productSlugCandidates(param);
  if (candidates.length === 1) return param;
  const rows = await prisma.product.findMany({
    where: { slug: { in: candidates } },
    select: { slug: true },
  });
  const found = new Set(rows.map((r) => r.slug));
  return candidates.find((c) => found.has(c)) ?? param;
}
