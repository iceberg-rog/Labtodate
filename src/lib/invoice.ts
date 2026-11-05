/**
 * The seller block for the site footer and legal pages, from Admin →
 * Documents → Company & bank (DB → process.env via ensureSettingsLoaded —
 * callers invoke that first). Quotes, invoices and receipts are rendered by
 * lib/documents (one renderer, frozen snapshots, real PDFs).
 */
export function getCompany() {
  const addr = (process.env.COMPANY_ADDRESS || '').trim();
  const addrLines = addr ? addr.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean) : [];
  return {
    name: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'Labtodate',
    addrLines,
    country: (process.env.COMPANY_COUNTRY || '').trim(),
    city: (process.env.COMPANY_CITY || '').trim(),
    phone: (process.env.COMPANY_PHONE || '').trim(),
    email: (process.env.COMPANY_EMAIL || process.env.SUPPORT_EMAIL || '').trim(),
    web: (process.env.COMPANY_WEBSITE || '').trim(),
    iban: (process.env.BANK_IBAN || '').trim(),
    bic: (process.env.BANK_SWIFT || '').trim(),
    vat: (process.env.COMPANY_VAT || '').trim(),
    kvk: (process.env.COMPANY_KVK || '').trim(),
    logoPath: (process.env.COMPANY_LOGO_URL || '').trim(),
  };
}
