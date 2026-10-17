/**
 * Imported supplier prices and VAT (A26) — pure.
 *
 * A WooCommerce Store API returns prices the way the shop DISPLAYS them; a
 * Dutch shop that shows prices incl. 21% BTW therefore exports gross prices.
 * Product.priceCents is always NET (excl. VAT): per shop, Admin → Shops →
 * Sync & settings says whether its prices include VAT and at which rate, and
 * the sync converts gross → net here. Rounding: half up to the cent.
 */
export function netFromImportedPrice(cents: number | null, includesVat: boolean, rateBp: number): number | null {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return cents == null ? null : cents;
  if (!includesVat || rateBp <= 0) return Math.round(cents);
  return Math.round((cents * 10000) / (10000 + rateBp));
}
