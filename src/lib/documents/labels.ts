/**
 * Every fixed text printed on a proforma, invoice or credit note — in the
 * document language (Settings → Documents & legal texts → Document language)
 * and individually overridable (DOC_TEXT_<KEY>). Pure data, client-safe.
 *
 * Issuing freezes the resolved texts into the snapshot (`snapshot.labels`), so
 * a later settings change never alters an issued document. Snapshots issued
 * before this existed carry no labels: the renderer then uses DOC_LABELS.en,
 * whose texts are exactly what those documents printed.
 *
 * Placeholders: {DATE} {AMOUNT} {NUMBER} {REFERENCE} {PAID} {OPEN} {DUE} {METHOD}.
 */

export type DocLanguage = 'en' | 'nl';

interface LabelDef {
  /** Admin label of the setting. */
  label: string;
  en: string;
  nl: string;
}

export const DOC_LABEL_DEFS = {
  TITLE_PROFORMA: { label: 'Title — proforma', en: 'Proforma invoice', nl: 'Pro-formafactuur' },
  TITLE_INVOICE: { label: 'Title — invoice', en: 'Invoice', nl: 'Factuur' },
  TITLE_CREDIT_NOTE: { label: 'Title — credit note', en: 'Credit note', nl: 'Creditnota' },
  STAMP_PROFORMA: { label: 'Stamp — proforma', en: 'Payment request', nl: 'Betaalverzoek' },
  STAMP_PAID: { label: 'Stamp — paid invoice', en: 'Paid', nl: 'Betaald' },
  STAMP_DUE: { label: 'Stamp — unpaid invoice', en: 'Payment due', nl: 'Te betalen' },
  STAMP_PARTLY_PAID: { label: 'Stamp — partly paid invoice', en: 'Partly paid', nl: 'Deels betaald' },
  STAMP_CREDIT_NOTE: { label: 'Stamp — credit note', en: 'Credit note', nl: 'Creditnota' },
  NO_PROFORMA: { label: 'Number label — proforma', en: 'Proforma no.', nl: 'Pro-formanummer' },
  NO_INVOICE: { label: 'Number label — invoice', en: 'Invoice no.', nl: 'Factuurnummer' },
  NO_CREDIT_NOTE: { label: 'Number label — credit note', en: 'Credit note no.', nl: 'Creditnotanummer' },
  ISSUE_DATE: { label: 'Issue date', en: 'Issue date', nl: 'Factuurdatum' },
  SUPPLY_DATE: { label: 'Date of supply', en: 'Date of supply', nl: 'Leveringsdatum' },
  ADVANCE_PAYMENT_DATE: { label: 'Date of the advance payment (paid before delivery)', en: 'Advance payment received', nl: 'Datum vooruitbetaling' },
  PAY_BY: { label: 'Proforma — pay by', en: 'Pay by', nl: 'Te betalen vóór' },
  PAYMENT_DUE_DATE: { label: 'Invoice — payment due', en: 'Payment due', nl: 'Vervaldatum' },
  CORRECTS_INVOICE: { label: 'Credit note — corrects invoice', en: 'Corrects invoice', nl: 'Correctie op factuur' },
  CORRECTS_INVOICE_VALUE: { label: 'Credit note — original invoice and its date', en: '{NUMBER} of {DATE}', nl: '{NUMBER} van {DATE}' },
  ORDER_NO: { label: 'Reference — order', en: 'Order no.', nl: 'Bestelnummer' },
  QUOTE_REF: { label: 'Reference — quote', en: 'Quote ref.', nl: 'Offertenummer' },
  PROFORMA_REF: { label: 'Reference — proforma', en: 'Proforma no.', nl: 'Pro-formanummer' },
  REPLACES: { label: 'Reference — replaces (revision)', en: 'Replaces', nl: 'Vervangt' },
  YOUR_PO: { label: 'Reference — buyer PO', en: 'Your PO no.', nl: 'Uw inkoopnummer' },
  DELIVERY_TERMS: { label: 'Reference — delivery terms', en: 'Delivery terms', nl: 'Leveringsvoorwaarden' },
  LEAD_TIME: { label: 'Reference — lead time', en: 'Lead time', nl: 'Levertijd' },
  BILL_TO: { label: 'Bill-to heading', en: 'Bill to', nl: 'Factuuradres' },
  SHIP_TO: { label: 'Ship-to heading', en: 'Ship to', nl: 'Afleveradres' },
  SHIP_TO_PENDING: { label: 'Ship-to not known yet', en: 'Shipping address to be confirmed.', nl: 'Afleveradres volgt.' },
  ATTN: { label: 'Attention-of prefix', en: 'Attn.', nl: 't.a.v.' },
  BUYER_VAT_ID: { label: 'Buyer VAT ID label', en: 'VAT ID', nl: 'Btw-id' },
  COL_DESCRIPTION: { label: 'Column — description', en: 'Description', nl: 'Omschrijving' },
  COL_QTY: { label: 'Column — quantity', en: 'Qty', nl: 'Aantal' },
  COL_UNIT: { label: 'Column — unit price', en: 'Unit price', nl: 'Stukprijs' },
  COL_VAT: { label: 'Column — VAT rate', en: 'VAT', nl: 'Btw' },
  COL_AMOUNT: { label: 'Column — amount', en: 'Amount', nl: 'Bedrag' },
  WARRANTY: { label: 'Line detail — warranty', en: 'Warranty', nl: 'Garantie' },
  SHIPPING_LINE: { label: 'Shipping line', en: 'Shipping & handling', nl: 'Verzend- en behandelkosten' },
  SUBTOTAL: { label: 'Subtotal (excl. VAT)', en: 'Subtotal (excl. VAT)', nl: 'Subtotaal (excl. btw)' },
  SUBTOTAL_MARGIN: { label: 'Subtotal (margin scheme)', en: 'Subtotal', nl: 'Subtotaal' },
  VAT_ROW: { label: 'VAT row', en: 'VAT', nl: 'Btw' },
  VAT_OVER: { label: 'VAT basis ("over €…")', en: 'over', nl: 'over' },
  MARGIN_NOTE: { label: 'Margin-scheme note under the totals', en: '* Margin scheme — VAT included, not shown separately', nl: '* Margeregeling — btw inbegrepen, niet apart vermeld' },
  TOTAL_PAID: { label: 'Total — paid invoice', en: 'Total paid', nl: 'Totaal betaald' },
  TOTAL_DUE: { label: 'Total — to pay', en: 'Total due', nl: 'Totaal te betalen' },
  TOTAL_CREDITED: { label: 'Total — credit note', en: 'Total credited', nl: 'Totaal gecrediteerd' },
  TOTAL: { label: 'Total — partly paid invoice', en: 'Total', nl: 'Totaal' },
  BOX_INSTRUCTIONS: { label: 'Proforma — payment box heading', en: 'Payment instructions', nl: 'Betaalgegevens' },
  BENEFICIARY: { label: 'Payment box — beneficiary', en: 'Beneficiary', nl: 'Begunstigde' },
  BANK: { label: 'Payment box — bank', en: 'Bank', nl: 'Bank' },
  IBAN: { label: 'Payment box — IBAN', en: 'IBAN', nl: 'IBAN' },
  BIC: { label: 'Payment box — BIC', en: 'BIC / SWIFT', nl: 'BIC / SWIFT' },
  REFERENCE: { label: 'Payment box — reference', en: 'Reference', nl: 'Betalingskenmerk' },
  AMOUNT: { label: 'Payment box — amount', en: 'Amount', nl: 'Bedrag' },
  NO_BANK_DETAILS: { label: 'Proforma without bank details', en: 'Our bank details will be sent to you by email. Please quote {REFERENCE} as the reference of your transfer.', nl: 'Onze bankgegevens ontvangt u per e-mail. Vermeld {REFERENCE} als betalingskenmerk.' },
  BOX_RECEIVED: { label: 'Paid invoice — box heading', en: 'Payment received', nl: 'Betaling ontvangen' },
  PAID_IN_FULL_ON: { label: 'Paid invoice — paid line', en: 'Paid in full on {DATE}', nl: 'Volledig betaald op {DATE}' },
  PAID_IN_FULL: { label: 'Paid invoice — paid line without a date', en: 'Paid in full', nl: 'Volledig betaald' },
  NO_PAYMENT_DUE: { label: 'Paid invoice — nothing due', en: 'No payment is due.', nl: 'Er staat geen bedrag meer open.' },
  BOX_DUE: { label: 'Unpaid invoice — box heading', en: 'Payment due', nl: 'Te betalen' },
  DUE_LINE: { label: 'Unpaid invoice — amount and date', en: '{AMOUNT} by {DATE}', nl: '{AMOUNT} vóór {DATE}' },
  PARTLY_PAID_LINE: { label: 'Partly paid invoice — line', en: 'Received {PAID} on {DATE}. Still due: {OPEN}.', nl: 'Ontvangen {PAID} op {DATE}. Nog te betalen: {OPEN}.' },
  BOX_CREDIT: { label: 'Credit note — box heading', en: 'Credit note', nl: 'Creditnota' },
  CREDIT_LINE: { label: 'Credit note — box line', en: 'This document credits invoice {NUMBER}.', nl: 'Dit document crediteert factuur {NUMBER}.' },
  CREDIT_LINE_DESC: { label: 'Credit note — line of a partial credit', en: 'Credit on invoice {NUMBER}', nl: 'Creditering op factuur {NUMBER}' },
  NOTE: { label: 'Note heading', en: 'Note', nl: 'Opmerking' },
  VAT_LEGAL_PREFIX: { label: 'VAT legal text prefix', en: 'VAT:', nl: 'Btw:' },
  CUSTOMER_VAT_ID: { label: 'VAT legal text — customer VAT ID', en: 'Customer VAT ID', nl: 'Btw-id afnemer' },
  SELLER_KVK: { label: 'Seller — KvK number', en: 'KvK (Chamber of Commerce)', nl: 'KvK-nummer' },
  SELLER_VAT_ID: { label: 'Seller — VAT ID', en: 'VAT ID (BTW-id)', nl: 'Btw-id' },
  FOOTER_KVK: { label: 'Footer — KvK', en: 'KvK', nl: 'KvK' },
  FOOTER_VAT: { label: 'Footer — VAT', en: 'VAT', nl: 'Btw' },
  PAGE_OF: { label: 'Page numbering ({PAGE} / {PAGES})', en: 'Page {PAGE} of {PAGES}', nl: 'Pagina {PAGE} van {PAGES}' },
  VAT_PENDING_UNKNOWN: { label: 'Proforma — VAT not final (no country yet)', en: 'VAT: the VAT treatment is confirmed on the invoice once the delivery country and, for EU businesses, the VAT ID are known.', nl: 'Btw: de btw-behandeling wordt op de factuur bevestigd zodra het afleverland en, voor EU-bedrijven, het btw-id bekend zijn.' },
  VAT_PENDING_REVIEW: { label: 'Proforma — VAT under review', en: 'VAT: the VAT on this proforma is being reviewed by our team; the invoice states the final VAT.', nl: 'Btw: de btw op deze pro-forma wordt door ons gecontroleerd; de factuur vermeldt de definitieve btw.' },
} as const satisfies Record<string, LabelDef>;

export type DocLabelKey = keyof typeof DOC_LABEL_DEFS;
export type DocLabels = Partial<Record<DocLabelKey, string>>;

export const DOC_LABEL_KEYS = Object.keys(DOC_LABEL_DEFS) as DocLabelKey[];

/** Setting key of a label override. */
export const docLabelSettingKey = (k: DocLabelKey) => `DOC_TEXT_${k}`;

/** The default text of a label in a language. */
export function defaultDocLabel(k: DocLabelKey, lang: DocLanguage = 'en'): string {
  return DOC_LABEL_DEFS[k][lang];
}

/** Locale facts per document language (dates, money). */
export const DOC_LOCALES: Record<DocLanguage, { dateLocale: string; moneyLocale: string }> = {
  en: { dateLocale: 'en-GB', moneyLocale: 'en-IE' },
  nl: { dateLocale: 'nl-NL', moneyLocale: 'nl-NL' },
};

/** Fill {PLACEHOLDERS}; unknown ones stay visible (never silently dropped). */
export function fillLabel(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
