import { parseVatId, vatIdLooksValid } from './vatid';

/**
 * VAT decision for a sale by a Dutch (home-country) seller of goods. Pure: no
 * I/O. The caller passes the settings (Admin → Documents → VAT), the buyer's
 * country and VAT ID, and an already-made VIES check. Unit tests in vat.test.ts.
 *
 *  - buyer country unknown ............. the default treatment (setting; 21% NL)
 *  - buyer in the home country ......... DOMESTIC, standard rate
 *  - buyer outside the EU .............. EXPORT 0% (setting), else DOMESTIC
 *  - buyer in another EU state with a VAT ID of a member state other than the
 *    home country, valid in VIES ....... REVERSE_CHARGE 0% + legal text
 *      · VIES says invalid ............. DOMESTIC (treated as no VAT ID)
 *      · VIES unreachable .............. setting: REVIEW (admin decides) /
 *                                         DOMESTIC / blocked
 *  - buyer in another EU state without a (valid) VAT ID ... DOMESTIC
 *
 * Shipping follows the goods (one treatment per document).
 */

export type VatTreatment = 'DOMESTIC' | 'REVERSE_CHARGE' | 'EXPORT' | 'REVIEW';

export const VAT_TREATMENTS: { value: Exclude<VatTreatment, 'REVIEW'>; label: string }[] = [
  { value: 'DOMESTIC', label: 'Standard VAT (home rate)' },
  { value: 'REVERSE_CHARGE', label: 'EU reverse charge — 0%' },
  { value: 'EXPORT', label: 'Export outside the EU — 0%' },
];

export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export interface VatSettings {
  homeCountry: string;
  /** Standard rate in percent, e.g. 21. */
  standardRatePct: number;
  /** Used when the buyer's country is not known (and when auto-decide is off). */
  defaultTreatment: Exclude<VatTreatment, 'REVIEW'>;
  autoDecide: boolean;
  reverseChargeEnabled: boolean;
  /** Reverse charge only with a VIES-confirmed VAT ID. */
  requireVies: boolean;
  viesDownPolicy: 'HOLD' | 'CHARGE_HOME' | 'BLOCK';
  exportZeroEnabled: boolean;
  /** Composer may override the suggested treatment. */
  allowOverride: boolean;
}

export const DEFAULT_VAT_SETTINGS: VatSettings = {
  homeCountry: 'NL',
  standardRatePct: 21,
  defaultTreatment: 'DOMESTIC',
  autoDecide: true,
  reverseChargeEnabled: true,
  requireVies: true,
  viesDownPolicy: 'HOLD',
  exportZeroEnabled: true,
  allowOverride: true,
};

export interface ViesEvidence {
  vatId: string;
  status: 'VALID' | 'INVALID' | 'UNAVAILABLE' | 'NOT_CHECKED';
  name?: string | null;
  address?: string | null;
  checkedAt?: string | null;
  error?: string | null;
}

export interface VatInput {
  country?: string | null;
  vatId?: string | null;
  vies?: ViesEvidence | null;
}

export interface VatDecision {
  treatment: VatTreatment;
  /** Basis points (2100 = 21%). 0 for the zero-rated treatments. */
  rateBp: number;
  /** Why — shown to staff in the composer and kept in the snapshot. */
  reason: string;
  /** The sale may not go ahead under the current rules (VIES down + BLOCK). */
  blocked?: boolean;
}

export function rateBpFor(treatment: VatTreatment, s: VatSettings): number {
  return treatment === 'DOMESTIC' ? Math.round(s.standardRatePct * 100) : 0;
}

export function decideVat(input: VatInput, s: VatSettings = DEFAULT_VAT_SETTINGS): VatDecision {
  const home = (s.homeCountry || 'NL').toUpperCase();
  const country = (input.country || '').trim().toUpperCase();
  const make = (treatment: VatTreatment, reason: string, blocked = false): VatDecision => ({
    treatment,
    rateBp: rateBpFor(treatment, s),
    reason,
    ...(blocked ? { blocked } : {}),
  });

  if (!s.autoDecide) return make(s.defaultTreatment, 'Automatic VAT rules are off: the default treatment applies.');
  if (!/^[A-Z]{2}$/.test(country)) return make(s.defaultTreatment, 'Buyer country unknown: the default treatment applies.');
  if (country === home) return make('DOMESTIC', `Buyer in ${home}: standard VAT.`);
  if (!EU_COUNTRIES.has(country)) {
    return s.exportZeroEnabled
      ? make('EXPORT', `Buyer outside the EU (${country}): export, 0%. Keep proof of export.`)
      : make('DOMESTIC', `Buyer outside the EU (${country}), but zero-rated export is switched off.`);
  }
  // Another EU member state.
  const raw = (input.vatId || '').trim();
  if (!raw) return make('DOMESTIC', `EU buyer (${country}) without a VAT ID: standard VAT.`);
  if (!s.reverseChargeEnabled) return make('DOMESTIC', 'EU reverse charge is switched off: standard VAT.');
  const parsed = parseVatId(raw);
  if (!parsed || !EU_COUNTRIES.has(parsed.country)) {
    return make('DOMESTIC', `“${raw}” is not an EU VAT ID: standard VAT.`);
  }
  if (parsed.country === home) {
    return make('DOMESTIC', `The VAT ID is from ${home} (the seller's own country): standard VAT.`);
  }
  if (!s.requireVies) {
    return vatIdLooksValid(raw)
      ? make('REVERSE_CHARGE', `EU business (${parsed.country}) with VAT ID ${parsed.vatId}: reverse charge, 0%.`)
      : make('DOMESTIC', `VAT ID ${parsed.vatId} has the wrong format for ${parsed.country}: standard VAT.`);
  }
  const vies = input.vies && input.vies.vatId === parsed.vatId ? input.vies : null;
  if (vies?.status === 'VALID') {
    return make('REVERSE_CHARGE', `VAT ID ${parsed.vatId} is valid in VIES${vies.name ? ` (${vies.name})` : ''}: reverse charge, 0%.`);
  }
  if (vies?.status === 'INVALID') {
    return make('DOMESTIC', `VIES says VAT ID ${parsed.vatId} is not valid: standard VAT.`);
  }
  const why = vies?.status === 'UNAVAILABLE'
    ? `VIES could not be reached for ${parsed.vatId}${vies.error ? ` (${vies.error})` : ''}`
    : `VAT ID ${parsed.vatId} has not been checked in VIES yet`;
  if (s.viesDownPolicy === 'CHARGE_HOME') return make('DOMESTIC', `${why}: standard VAT (setting).`);
  if (s.viesDownPolicy === 'BLOCK') return make('REVIEW', `${why}: the rules block the sale until VIES confirms it.`, true);
  return make('REVIEW', `${why}: choose the VAT treatment yourself, or check again.`);
}

/** VAT amount for a net base (round half up, cents). */
export function vatCents(netCents: number, rateBp: number): number {
  return Math.round((netCents * rateBp) / 10_000);
}

/** "21%", "9%", "0%". */
export function fmtRateBp(bp: number): string {
  const n = bp / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}
