import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingBool, settingEnum, settingPercentBp, settingString } from '@/lib/settings';
import type { CountryFacts, TaxSettings } from './determine';

/** Tax settings from the registry (Admin → Settings → Tax & VAT / Sales channel). */
export async function loadTaxSettings(): Promise<TaxSettings> {
  await ensureSettingsLoaded();
  return {
    homeCountry: settingString('TAX_HOME_COUNTRY').toUpperCase() || 'NL',
    standardRateBp: settingPercentBp('TAX_STANDARD_RATE_PCT'),
    shippingFollowsMain: settingBool('TAX_SHIPPING_FOLLOWS_MAIN_SUPPLY'),
    icsEnabled: settingBool('TAX_ICS_ZERO_RATE_ENABLED'),
    icsRequireVies: settingBool('TAX_ICS_REQUIRE_VIES_VALID'),
    viesDownPolicy: settingEnum('TAX_VIES_DOWN_POLICY'),
    exportZeroEnabled: settingBool('TAX_EXPORT_ZERO_RATE_ENABLED'),
    euB2cMode: settingEnum('TAX_EU_B2C_MODE'),
    marginSchemeEnabled: settingBool('TAX_MARGIN_SCHEME_ENABLED'),
    salesMode: settingEnum('SALES_MODE'),
    legalTexts: {
      ICS: settingString('TAX_LEGAL_TEXT_ICS'),
      EXPORT: settingString('TAX_LEGAL_TEXT_EXPORT'),
      MARGIN: settingString('TAX_LEGAL_TEXT_MARGIN'),
      OSS: settingString('TAX_LEGAL_TEXT_OSS'),
    },
  };
}

export interface CountryRow {
  country: string;
  name: string;
  isEu: boolean;
  vatStandardRateBp: number | null;
  mode: 'ALLOW' | 'REVIEW' | 'BLOCK';
  note: string | null;
}

/** Built-in EU list: used only if the CountryPolicy table is unreachable/empty. */
const EU_FALLBACK = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

export function countryFactsFrom(rows: CountryRow[]): CountryFacts {
  const byCode = new Map(rows.map((r) => [r.country.toUpperCase(), r]));
  return {
    isEu: (c) => {
      const r = byCode.get(c.toUpperCase());
      return r ? r.isEu : rows.length === 0 && EU_FALLBACK.has(c.toUpperCase());
    },
    standardRateBp: (c) => byCode.get(c.toUpperCase())?.vatStandardRateBp ?? null,
  };
}

export async function loadCountryRows(): Promise<CountryRow[]> {
  try {
    return await prisma.countryPolicy.findMany({ orderBy: { name: 'asc' } });
  } catch {
    return [];
  }
}

export async function loadCountryFacts(): Promise<CountryFacts> {
  return countryFactsFrom(await loadCountryRows());
}
