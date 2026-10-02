/**
 * Clean-up for listings imported from a supplier's WooCommerce shop.
 *
 * Imported products are sold as "lab2date Verified Supplier" (supplier
 * micro-sites are intentionally hidden), so the source shop's own name, its
 * links and its "see our website" sales copy must not reach the product page.
 * Used by the runtime importer and by prisma/clean-imported-branding.ts for
 * rows imported before this existed.
 */

export interface SupplierRef {
  /** Company name, e.g. "Lab2Parts". */
  name: string;
  /** Any of the shop's URLs (website, import source). */
  urls?: (string | null | undefined)[];
}

/** Placeholder title the importers give a product whose source name is empty. */
export const PLACEHOLDER_TITLE_RE = /^Product \d+$/;

export function stripHtml(h: string): string {
  return h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "https://www.lab2.nl/shop" → "lab2" (the label before the TLD). */
function domainLabel(url: string): string | null {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch {
    return null;
  }
}

/**
 * Matches text that identifies the supplier: its name or domain as a whole
 * word ("LAB2parts has…", "www.lab2.nl"), or "our website" copy pointing the
 * buyer to the supplier's own shop (also the Dutch "onze website").
 */
export function supplierPattern(s: SupplierRef): RegExp {
  const tokens = new Set<string>();
  const compact = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.length >= 4) tokens.add(compact);
  for (const u of s.urls ?? []) {
    const label = u ? domainLabel(u) : null;
    if (label && label.length >= 4) tokens.add(label);
  }
  const alts = [String.raw`\b(?:our|onze)\s+(?:web\s?shop|webs?ite|webiste)\b`];
  if (tokens.size) {
    alts.push(`(?<![a-z0-9])(?:${[...tokens].map(escapeRegExp).join('|')})(?![a-z0-9])`);
  }
  return new RegExp(alts.join('|'), 'i');
}

function blockText(html: string): string {
  const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
  return `${text} ${hrefs.join(' ')}`;
}

/**
 * Drop paragraphs, headings and list items that identify the supplier, unwrap
 * any remaining links (no outbound links on listings), and tidy up the empty
 * paragraphs / lists left behind. Returns null when nothing is left.
 */
export function cleanSupplierHtml(html: string | null | undefined, s: SupplierRef): string | null {
  if (!html) return null;
  const re = supplierPattern(s);
  const out = html
    .replace(/<(p|h[1-6]|li)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => (re.test(blockText(block)) ? '' : block))
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, '$1')
    .replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p\s*>/gi, '')
    .replace(/<(ul|ol)\b[^>]*>\s*<\/\1\s*>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return out || null;
}

/**
 * WooCommerce Store API prices are integer strings in the currency's minor
 * unit (`currency_minor_unit` decimals). Product.priceCents always has two,
 * so a 0-decimal shop's "50" is €50 (5000), not €0.50.
 */
export function wooPriceToCents(prices: { price?: string; currency_minor_unit?: number } | null | undefined): number | null {
  const raw = parseFloat(prices?.price ?? '0');
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unit = prices?.currency_minor_unit;
  const minor = typeof unit === 'number' && Number.isInteger(unit) ? unit : 2;
  return Math.round(raw * 10 ** (2 - minor));
}
