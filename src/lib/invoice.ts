/**
 * Company identity printed on documents, the footer and emails.
 *
 * Proforma invoices and invoices themselves are rendered by
 * src/lib/documents (one A4 HTML template → PDF via headless Chromium); the
 * old Dutch "Factuur" HTML that pages printed with window.print() is gone.
 */

import { isDeliverableEmail } from './email-address';

// Resolved at render time so admin Settings → Company / Payments / Logo
// changes take effect on the next request (DB → process.env via
// ensureSettingsLoaded — callers invoke that first).
export function getCompany() {
  const addr = (process.env.COMPANY_ADDRESS || '').trim();
  const addrLines = addr ? addr.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean) : [];
  return {
    name: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'Labtodate',
    addrLines,
    country: (process.env.COMPANY_COUNTRY || '').trim(),
    city: (process.env.COMPANY_CITY || '').trim(),
    phone: (process.env.COMPANY_PHONE || '').trim(),
    // Never print a placeholder (billing@lab2date.local) on a document or the footer.
    email: [process.env.COMPANY_EMAIL, process.env.SUPPORT_EMAIL].map((e) => (e || '').trim()).find((e) => isDeliverableEmail(e)) ?? '',
    web: (process.env.COMPANY_WEBSITE || '').trim(),
    iban: (process.env.BANK_IBAN || '').trim(),
    bic: (process.env.BANK_SWIFT || '').trim(),
    vat: (process.env.COMPANY_VAT || '').trim(),
    kvk: (process.env.COMPANY_KVK || '').trim(),
    logoPath: (process.env.COMPANY_LOGO_URL || '').trim(),
  };
}
