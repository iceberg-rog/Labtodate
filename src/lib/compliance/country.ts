import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum } from '@/lib/settings';

/**
 * Ship-to / sell-to country policy (A12 / B13 groundwork). One table
 * (CountryPolicy: ALLOW | REVIEW | BLOCK, edited in Admin → Settings →
 * Compliance & countries) checked by ONE helper in every write path that sets
 * a destination: checkout (single + cart), the payment-page address, the admin
 * address edit, and the Stripe allowed_countries list.
 *
 *   ALLOW   sell and ship normally
 *   REVIEW  order allowed but put on hold (holdReason COMPLIANCE) until staff clear it
 *   BLOCK   refused, with the reason
 *
 * Unknown countries follow COMPLIANCE_UNKNOWN_COUNTRY_POLICY (default REVIEW).
 * `decideCountry` is pure (unit tests: country.test.ts).
 */

export type ShipPolicy = 'ALLOW' | 'REVIEW' | 'BLOCK';

export interface CountryPolicyRow {
  country: string;
  name: string;
  isEu: boolean;
  mode: ShipPolicy;
  note: string | null;
}

export interface CountryDecision {
  country: string;
  known: boolean;
  name: string | null;
  isEu: boolean;
  mode: ShipPolicy;
  note: string | null;
  /** One sentence for the buyer / staff. */
  reason: string;
}

export function decideCountry(raw: string | null | undefined, rows: CountryPolicyRow[], unknownPolicy: 'REVIEW' | 'BLOCK'): CountryDecision {
  const code = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return { country: code, known: false, name: null, isEu: false, mode: 'BLOCK', note: null, reason: `“${raw ?? ''}” is not a 2-letter country code.` };
  }
  const row = rows.find((r) => r.country.toUpperCase() === code);
  if (!row) {
    return {
      country: code, known: false, name: null, isEu: false, mode: unknownPolicy, note: null,
      reason: unknownPolicy === 'BLOCK'
        ? `We do not ship to ${code}.`
        : `Orders to ${code} are reviewed by our team before payment is requested.`,
    };
  }
  const reason = row.mode === 'ALLOW'
    ? `${row.name}: allowed.`
    : row.mode === 'REVIEW'
      ? `Orders to ${row.name} are reviewed by our team (export compliance) before payment is requested.`
      : `We cannot sell or ship to ${row.name}.`;
  return { country: code, known: true, name: row.name, isEu: row.isEu, mode: row.mode, note: row.note, reason };
}

async function rows(): Promise<CountryPolicyRow[]> {
  return prisma.countryPolicy.findMany({ select: { country: true, name: true, isEu: true, mode: true, note: true }, orderBy: { name: 'asc' } });
}

/** Check one destination against the live table + settings. */
export async function checkCountry(code: string | null | undefined): Promise<CountryDecision> {
  await ensureSettingsLoaded();
  return decideCountry(code, await rows(), settingEnum<'REVIEW' | 'BLOCK'>('COMPLIANCE_UNKNOWN_COUNTRY_POLICY'));
}

/** Countries a buyer may pick in an address form (BLOCK left out, REVIEW flagged). */
export async function countryOptions(): Promise<Array<{ code: string; name: string; review: boolean }>> {
  return (await rows()).filter((r) => r.mode !== 'BLOCK').map((r) => ({ code: r.country, name: r.name, review: r.mode === 'REVIEW' }));
}

/** Stripe Checkout allowed_countries: only ALLOW (REVIEW needs staff before payment). */
export async function stripeAllowedCountries(): Promise<string[]> {
  return (await rows()).filter((r) => r.mode === 'ALLOW').map((r) => r.country);
}
