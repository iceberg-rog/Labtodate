/** Settings keys edited on Admin → Documents → Company & bank (in form order). */
export const COMPANY_FIELDS = [
  'COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'COMPANY_COUNTRY', 'COMPANY_CITY', 'COMPANY_KVK', 'COMPANY_VAT',
  'COMPANY_PHONE', 'COMPANY_EMAIL', 'COMPANY_WEBSITE', 'BANK_NAME', 'BANK_IBAN', 'BANK_SWIFT', 'BANK_REFERENCE_HINT',
] as const;

export const COMPANY_FIELD_META: Record<(typeof COMPANY_FIELDS)[number], { label: string; hint: string; multiline?: boolean; group: 'Company' | 'Bank' }> = {
  COMPANY_LEGAL_NAME: { label: 'Legal name', hint: 'Registered name, e.g. “Labtodate B.V.”. Printed on every document.', group: 'Company' },
  COMPANY_ADDRESS: { label: 'Address', hint: 'Street and number, postcode and city — one per line.', multiline: true, group: 'Company' },
  COMPANY_COUNTRY: { label: 'Country', hint: 'e.g. Netherlands. Added under the address.', group: 'Company' },
  COMPANY_CITY: { label: 'City on quotes', hint: 'Shown before the date on quotes (“Utrecht, 5 November 2026”). Leave empty to show only the date.', group: 'Company' },
  COMPANY_KVK: { label: 'KvK number', hint: '8 digits (Chamber of Commerce).', group: 'Company' },
  COMPANY_VAT: { label: 'VAT number', hint: 'e.g. NL123456789B01.', group: 'Company' },
  COMPANY_PHONE: { label: 'Phone', hint: 'Shown in the company block.', group: 'Company' },
  COMPANY_EMAIL: { label: 'Billing e-mail', hint: 'Shown on documents. A copy of every issued document goes here (Documents → General).', group: 'Company' },
  COMPANY_WEBSITE: { label: 'Website', hint: 'e.g. labtodate.com.', group: 'Company' },
  BANK_NAME: { label: 'Bank', hint: 'e.g. ING Bank.', group: 'Bank' },
  BANK_IBAN: { label: 'IBAN', hint: 'Buyers transfer to this account. Without it, documents say the bank details follow by e-mail.', group: 'Bank' },
  BANK_SWIFT: { label: 'BIC / SWIFT', hint: 'For payments from outside the SEPA area, e.g. INGBNL2A.', group: 'Bank' },
  BANK_REFERENCE_HINT: { label: 'Reference hint', hint: 'One line in the payment instructions, e.g. “Use the quote number as reference”.', group: 'Bank' },
};
