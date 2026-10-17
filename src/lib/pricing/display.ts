/**
 * How a sell price is SHOWN (A26 / B01 price display basis) — pure, client-safe.
 *
 * Every public price (cards, product page, search, cart, checkout lines) goes
 * through `priceParts()` so the VAT basis is always stated and always the same:
 *   EXCL  €1,000 excl. VAT
 *   INCL  €1,210 incl. VAT                       (home standard rate)
 *   BOTH  €1,000 excl. VAT  ·  €1,210 incl. VAT
 * The exact VAT of an order (country, VAT ID, VIES) is decided at checkout by
 * the VAT engine; "incl." on the catalogue uses the home standard rate.
 * Margin-scheme items (when the scheme is on) have no separate VAT: their
 * price is final and labelled as such.
 */
import { taxOn } from '@/lib/tax/determine';

export type PriceDisplayMode = 'EXCL' | 'INCL' | 'BOTH';

export interface PriceDisplaySettings {
  /** Effective mode (see effectiveDisplayMode). */
  mode: PriceDisplayMode;
  standardRateBp: number;
  labelExcl: string;
  labelIncl: string;
  labelMargin: string;
  /** Short note shown under prices (may be empty). */
  note: string;
  marginSchemeEnabled: boolean;
}

/** Consumer prices must include VAT: with consumers allowed, EXCL becomes BOTH. */
export function effectiveDisplayMode(configured: string, salesMode: string): PriceDisplayMode {
  const m: PriceDisplayMode = configured === 'INCL' || configured === 'BOTH' ? configured : 'EXCL';
  return m === 'EXCL' && salesMode === 'B2B_AND_B2C' ? 'BOTH' : m;
}

export interface PriceParts {
  primaryCents: number;
  primaryLabel: string;
  secondaryCents: number | null;
  secondaryLabel: string | null;
}

export function grossOf(netCents: number, rateBp: number): number {
  return netCents + taxOn(netCents, rateBp);
}

export function priceParts(netCents: number, s: PriceDisplaySettings, opts: { scheme?: 'STANDARD' | 'MARGIN' | null } = {}): PriceParts {
  if (opts.scheme === 'MARGIN' && s.marginSchemeEnabled) {
    return { primaryCents: netCents, primaryLabel: s.labelMargin, secondaryCents: null, secondaryLabel: null };
  }
  const gross = grossOf(netCents, s.standardRateBp);
  if (s.mode === 'INCL') return { primaryCents: gross, primaryLabel: s.labelIncl, secondaryCents: null, secondaryLabel: null };
  if (s.mode === 'BOTH') return { primaryCents: netCents, primaryLabel: s.labelExcl, secondaryCents: gross, secondaryLabel: s.labelIncl };
  return { primaryCents: netCents, primaryLabel: s.labelExcl, secondaryCents: null, secondaryLabel: null };
}

/**
 * A price the buyer typed in a filter (shown basis) → the net amount stored in
 * Product.displayPriceCents. In INCL mode the shown price contains the home
 * VAT; `round` picks the safe side of the bound (floor for a minimum, ceil for
 * a maximum) so the filter never hides a matching item.
 */
export function shownToNetCents(shownCents: number, s: Pick<PriceDisplaySettings, 'mode' | 'standardRateBp'>, round: 'floor' | 'ceil'): number {
  if (s.mode !== 'INCL') return shownCents;
  const net = (shownCents * 10000) / (10000 + s.standardRateBp);
  return round === 'floor' ? Math.floor(net) : Math.ceil(net);
}
