import { ensureSettingsLoaded } from '@/lib/settings';
import { companyLogoDataUri } from './logo';
import type { CompanySnapshot } from './types';

/**
 * The seller block printed on every document, from Admin → Documents →
 * Company & bank (the COMPANY_* / BANK_* settings, DB over .env).
 */
export async function companySnapshot(opts: { withLogo?: boolean } = {}): Promise<CompanySnapshot> {
  await ensureSettingsLoaded();
  const e = (k: string) => (process.env[k] || '').trim();
  const address = e('COMPANY_ADDRESS');
  const addressLines = address ? address.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean) : [];
  const country = e('COMPANY_COUNTRY');
  if (country && !addressLines.some((l) => l.toLowerCase() === country.toLowerCase())) addressLines.push(country);
  const logoUrl = e('COMPANY_LOGO_URL');
  return {
    name: e('COMPANY_LEGAL_NAME') || e('SITE_NAME') || 'Labtodate',
    addressLines,
    city: e('COMPANY_CITY'),
    phone: e('COMPANY_PHONE'),
    email: e('COMPANY_EMAIL') || e('SUPPORT_EMAIL'),
    web: e('COMPANY_WEBSITE'),
    kvk: e('COMPANY_KVK'),
    vat: e('COMPANY_VAT'),
    iban: e('BANK_IBAN'),
    bic: e('BANK_SWIFT'),
    bank: e('BANK_NAME'),
    logo: opts.withLogo === false ? null : await companyLogoDataUri(logoUrl),
  };
}

export interface ReadinessItem {
  field: string;
  label: string;
  why: string;
  /** Legally required on a Dutch invoice (blocks when readiness = BLOCK). */
  required: boolean;
}

/** What is still missing in the company block, most important first. */
export function readiness(c: CompanySnapshot): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const need = (ok: boolean, field: string, label: string, why: string, required: boolean) => {
    if (!ok) out.push({ field, label, why, required });
  };
  need(!!(process.env.COMPANY_LEGAL_NAME || '').trim(), 'COMPANY_LEGAL_NAME', 'Legal name', 'An invoice must show the registered company name.', true);
  need(c.addressLines.length > 0, 'COMPANY_ADDRESS', 'Address', 'An invoice must show the seller’s address.', true);
  need(!!c.vat, 'COMPANY_VAT', 'VAT number', 'An invoice must show the seller’s VAT number.', true);
  need(!!c.kvk, 'COMPANY_KVK', 'KvK number', 'Dutch business documents must show the KvK number.', true);
  need(!!c.iban, 'BANK_IBAN', 'IBAN', 'Without it, quotes say “bank details follow by e-mail” and buyers cannot pay.', true);
  need(!!c.email, 'COMPANY_EMAIL', 'Billing e-mail', 'Shown on documents; billing copies go there.', false);
  need(!!c.bic, 'BANK_SWIFT', 'BIC', 'Needed by buyers paying from outside the SEPA area.', false);
  need(!!c.phone, 'COMPANY_PHONE', 'Phone', 'Shown in the company block.', false);
  need(!!c.logo, 'COMPANY_LOGO_URL', 'Logo', 'Documents show the company name in text instead.', false);
  return out;
}
