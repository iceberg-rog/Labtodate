import { escapeHtml as esc } from '@/lib/email-html';
import type { DocumentSnapshot, DocPartySnapshot } from './snapshot';
import { DOC_LABEL_DEFS, fillLabel, type DocLabelKey } from './labels';

/**
 * The ONE renderer for commercial documents: a complete, self-contained A4
 * HTML page (inline CSS, no scripts, no external requests — the logo is a
 * data: URI) rendered ONLY from an issued document's frozen snapshot
 * (FiscalDocument.snapshot). The PDF is printed from exactly this HTML once,
 * stored, and every later download serves those stored bytes.
 *
 * Texts, language, date / money formats and time zone come from the snapshot
 * (`labels`, `locale`, frozen at issue). A snapshot issued before those
 * existed has neither: it renders with the English texts and formats it was
 * issued with, so its preview never changes.
 *
 * Every value that came from a person (buyer name, company, address, item
 * title, note, company settings) is escaped and carries dir="auto", so
 * Persian / Arabic names and addresses render right-to-left correctly inside
 * the layout.
 */

const DEFAULT_LOCALE = { lang: 'en', dateLocale: 'en-GB', moneyLocale: 'en-IE', timeZone: 'Europe/Amsterdam' };

/**
 * What proformas issued without bank details printed (before issuing required
 * them). Kept only to re-render those documents as they were; no new document
 * prints it (issue.ts sellerDetailsMissing).
 */
const LEGACY_NO_BANK_DETAILS = 'Our bank details will be sent to you by email. Please quote {REFERENCE} as the reference of your transfer.';

export function fmtDocDate(d: Date | string, locale: { dateLocale?: string; timeZone?: string } = {}): string {
  return new Date(d).toLocaleDateString(locale.dateLocale ?? DEFAULT_LOCALE.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: locale.timeZone ?? DEFAULT_LOCALE.timeZone });
}

/** Date-only values (offer validity / payment due) are stored as the END of a
 *  UTC calendar day — shown in UTC so every surface names the same day. */
export function fmtDocDay(d: Date | string, locale: { dateLocale?: string } = {}): string {
  return new Date(d).toLocaleDateString(locale.dateLocale ?? DEFAULT_LOCALE.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDocMoney(cents: number, currency: string, moneyLocale = DEFAULT_LOCALE.moneyLocale): string {
  try {
    return new Intl.NumberFormat(moneyLocale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Basis points → "21%", "25.5%"; null → "—" (rate not determinable). */
export function fmtRate(bp: number | null): string {
  if (bp == null) return '—';
  const n = bp / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** User-entered text: escaped + bidi-isolated. */
function u(value: string | null | undefined, tag = 'div', cls = ''): string {
  if (!value) return '';
  return `<${tag} dir="auto"${cls ? ` class="${cls}"` : ''}>${esc(value)}</${tag}>`;
}

const CSS = `
  @page { size: A4; margin: 12mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: #111827; background: #e5e7eb;
    font-family: Inter, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma, "DejaVu Sans", sans-serif;
    font-size: 10pt; line-height: 1.38;
  }
  .sheet { width: 210mm; min-height: 297mm; margin: 24px auto; padding: 14mm; background: #fff; box-shadow: 0 10px 40px rgba(0,0,0,.12); }
  @media print {
    body { background: #fff; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  }
  [dir="auto"] { unicode-bidi: plaintext; text-align: start; }
  h1, h2, h3, p { margin: 0; }
  .muted { color: #6b7280; }
  .strong { font-weight: 700; }
  .mono { font-family: "JetBrains Mono", Consolas, "DejaVu Sans Mono", monospace; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 14px; border-bottom: 3px solid #0E4F40; }
  .brand img { max-height: 64px; max-width: 240px; display: block; }
  .brand .name { font-size: 20pt; font-weight: 800; letter-spacing: -0.02em; color: #0E4F40; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 20pt; font-weight: 800; letter-spacing: -0.01em; color: #0E4F40; text-transform: uppercase; }
  .doc-title .no { font-size: 12pt; font-weight: 700; margin-top: 2px; }
  .stamp { display: inline-block; margin-top: 8px; padding: 3px 10px; border: 2px solid currentColor; border-radius: 6px; font-size: 9pt; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .st-paid { color: #047857; } .st-unpaid { color: #b45309; } .st-review { color: #0369a1; } .st-void { color: #b91c1c; }
  .head { display: flex; justify-content: space-between; gap: 24px; margin-top: 12px; }
  .from { font-size: 9pt; line-height: 1.5; max-width: 58%; }
  .from .strong { font-size: 10pt; }
  table { border-collapse: collapse; }
  .meta td { padding: 2px 0 2px 16px; font-size: 9.5pt; vertical-align: top; }
  .meta td:first-child { color: #6b7280; padding-left: 0; white-space: nowrap; }
  .meta td:last-child { font-weight: 700; text-align: right; }
  .parties { display: flex; gap: 24px; margin-top: 14px; }
  .party { flex: 1; min-width: 0; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 8px; overflow-wrap: anywhere; }
  .party h3, .box h3 { font-size: 8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
  table.items { width: 100%; margin-top: 14px; }
  table.items thead { display: table-header-group; }
  table.items th { background: #0E4F40; color: #fff; font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 7px 8px; text-align: right; }
  table.items th:first-child { text-align: left; border-top-left-radius: 6px; }
  table.items th:last-child { border-top-right-radius: 6px; }
  table.items td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right; vertical-align: top; white-space: nowrap; }
  table.items td.desc { text-align: left; white-space: normal; overflow-wrap: anywhere; width: 52%; }
  table.items td.desc .detail { color: #6b7280; font-size: 9pt; }
  tr { break-inside: avoid; }
  .summary { display: flex; gap: 24px; justify-content: space-between; align-items: flex-start; margin-top: 12px; break-inside: avoid; }
  .box { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #f9fafb; font-size: 9.5pt; }
  .box.paid { border-color: #a7f3d0; background: #ecfdf5; }
  .box.void { border-color: #fecaca; background: #fef2f2; }
  .box table td { padding: 2px 12px 2px 0; vertical-align: top; }
  .box table td:first-child { color: #6b7280; white-space: nowrap; }
  .box table td:last-child { font-weight: 700; }
  table.totals { min-width: 64mm; }
  table.totals td { padding: 4px 0 4px 18px; text-align: right; white-space: nowrap; }
  table.totals td:first-child { color: #4b5563; text-align: left; padding-left: 0; }
  table.totals tr.grand td { border-top: 2px solid #111827; font-size: 12pt; font-weight: 800; padding-top: 7px; color: #111827; }
  .notes { margin-top: 12px; padding: 8px 12px; border-left: 3px solid #A3E635; background: #f9fafb; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 9.5pt; break-inside: avoid; }
  .terms { margin-top: 10px; font-size: 8.5pt; color: #4b5563; break-inside: avoid; }
  .terms li { margin: 2px 0; }
  .vat-legal { margin-top: 12px; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 8.5pt; color: #111827; background: #f9fafb; white-space: pre-wrap; break-inside: avoid; }
  .vat-pending { margin-top: 12px; padding: 8px 12px; border: 1px dashed #b45309; border-radius: 8px; font-size: 8.5pt; color: #92400e; break-inside: avoid; }
  .clauses { margin-top: 10px; font-size: 8pt; color: #374151; break-inside: avoid; }
  table.totals td.sub { color: #6b7280; font-size: 8.5pt; padding-top: 0; }
  .legal { margin-top: 10px; padding-top: 6px; border-top: 1px solid #e5e7eb; font-size: 7.5pt; color: #6b7280; text-align: center; line-height: 1.6; break-inside: avoid; }
  /* Documents issued with frozen texts: the reference table keeps its natural height. */
  body.v2 .meta { align-self: flex-start; }
  /* Compact variant: used when the normal layout spills a few lines onto a
     second page (pdf.ts tries it before accepting an extra page). */
  body.compact { font-size: 9.5pt; line-height: 1.3; }
  body.compact .top { padding-bottom: 10px; }
  body.compact .head, body.compact .parties { margin-top: 9px; }
  body.compact table.items { margin-top: 10px; }
  body.compact table.items td { padding: 4px 8px; }
  body.compact .summary, body.compact .notes, body.compact .vat-legal, body.compact .vat-pending { margin-top: 8px; }
  body.compact .terms, body.compact .clauses, body.compact .legal { margin-top: 6px; }
  body.compact .brand img { max-height: 52px; }
`;

/** A free-text block (offer remark, credit reason) under its heading. */
function noteBlock(heading: string, text: string): string {
  return `<section class="notes"><div class="muted" style="font-size:8pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px;">${esc(heading)}</div><div dir="auto">${esc(text)}</div></section>`;
}

const STAMP_CLASS: Record<string, string> = {
  PROFORMA: 'st-unpaid',
  INVOICE_PAID: 'st-paid',
  INVOICE_DUE: 'st-unpaid',
  INVOICE_PARTLY: 'st-unpaid',
  CREDIT_NOTE: 'st-review',
};

export function renderDocumentHtml(doc: DocumentSnapshot, opts: { logoDataUri?: string | null; compact?: boolean } = {}): string {
  const c = doc.seller;
  const loc = doc.locale ?? DEFAULT_LOCALE;
  /** Text in the document language (frozen labels; English for older documents). */
  const L = (k: DocLabelKey): string => doc.labels?.[k] ?? DOC_LABEL_DEFS[k].en;
  const layout2 = !!doc.labels; // documents issued with the frozen-texts layout
  const money = (cents: number) => fmtDocMoney(cents, doc.currency, loc.moneyLocale);
  const date = (d: string | Date) => fmtDocDate(d, loc);
  const day = (d: string | Date) => fmtDocDay(d, loc);
  const isProforma = doc.kind === 'PROFORMA';
  const isCredit = doc.kind === 'CREDIT_NOTE';
  const p = doc.payment;
  const stampKey = isProforma ? 'PROFORMA' : isCredit ? 'CREDIT_NOTE' : p?.kind === 'PAID' ? 'INVOICE_PAID' : p?.kind === 'PARTLY_PAID' ? 'INVOICE_PARTLY' : 'INVOICE_DUE';
  const stampLabel = isProforma ? L('STAMP_PROFORMA') : isCredit ? L('STAMP_CREDIT_NOTE') : p?.kind === 'PAID' ? L('STAMP_PAID') : p?.kind === 'PARTLY_PAID' ? L('STAMP_PARTLY_PAID') : L('STAMP_DUE');
  const title = layout2 ? (isProforma ? L('TITLE_PROFORMA') : isCredit ? L('TITLE_CREDIT_NOTE') : L('TITLE_INVOICE')) : doc.title;

  const party = (heading: string, pt: DocPartySnapshot | null, emptyText: string): string => {
    if (!pt) return `<div class="party"><h3>${heading}</h3><p class="muted">${emptyText}</p></div>`;
    const ids = `${pt.email ? `<div class="muted" dir="ltr">${esc(pt.email)}</div>` : ''}${pt.phone ? `<div class="muted" dir="ltr">${esc(pt.phone)}</div>` : ''}${pt.vatId ? `<div class="muted">${esc(L('BUYER_VAT_ID'))} <span dir="ltr" class="mono">${esc(pt.vatId)}</span></div>` : ''}`;
    if (pt.attention !== undefined) {
      // Company / Attn. contact / address / VAT ID / e-mail.
      const head = pt.company ? u(pt.company, 'div', 'strong') : u(pt.name, 'div', 'strong');
      const attn = pt.attention ? `<div><span class="muted">${esc(L('ATTN'))}</span> <span dir="auto">${esc(pt.attention)}</span></div>` : '';
      return `<div class="party"><h3>${heading}</h3>${head}${attn}${pt.lines.map((l) => u(l)).join('')}${ids}</div>`;
    }
    return `<div class="party">
    <h3>${heading}</h3>
    ${pt.company ? u(pt.company, 'div', 'strong') : ''}
    ${u(pt.name, 'div', pt.company ? '' : 'strong')}
    ${pt.lines.map((l) => u(l)).join('')}
    ${ids}
  </div>`;
  };

  const companyLines = [...c.addressLines.map((l) => u(l)), c.country ? u(c.country) : ''].join('');
  const companyIds = [
    c.kvk ? `<div>${esc(L('SELLER_KVK'))} <span class="mono" dir="ltr">${esc(c.kvk)}</span></div>` : '',
    c.vatId ? `<div>${esc(L('SELLER_VAT_ID'))} <span class="mono" dir="ltr">${esc(c.vatId)}</span></div>` : '',
    c.eori && doc.vat.treatment === 'EXPORT_ZERO' ? `<div>EORI <span class="mono" dir="ltr">${esc(c.eori)}</span></div>` : '',
    c.email ? `<div dir="ltr">${esc(c.email)}</div>` : '',
    c.phone ? `<div dir="ltr">${esc(c.phone)}</div>` : '',
    c.web ? `<div dir="ltr">${esc(c.web)}</div>` : '',
  ].join('');

  const numberLabel = isProforma ? L('NO_PROFORMA') : isCredit ? L('NO_CREDIT_NOTE') : L('NO_INVOICE');
  const metaRows: Array<[string, string]> = [
    [esc(numberLabel), `<span class="mono">${esc(doc.number)}</span>`],
    [esc(L('ISSUE_DATE')), esc(date(doc.issueDate))],
  ];
  if (doc.supplyDate) metaRows.push([esc(L('SUPPLY_DATE')), esc(date(doc.supplyDate))]);
  if (doc.advancePaymentDate) metaRows.push([esc(L('ADVANCE_PAYMENT_DATE')), esc(date(doc.advancePaymentDate))]);
  if (doc.dueDate && (isProforma || p?.kind === 'DUE' || p?.kind === 'PARTLY_PAID')) metaRows.push([esc(isProforma ? L('PAY_BY') : L('PAYMENT_DUE_DATE')), esc(day(doc.dueDate))]);
  if (doc.original) {
    metaRows.push([
      esc(L('CORRECTS_INVOICE')),
      layout2
        ? esc(fillLabel(L('CORRECTS_INVOICE_VALUE'), { NUMBER: doc.original.number, DATE: date(doc.original.issueDate) })).replace(esc(doc.original.number), `<span class="mono">${esc(doc.original.number)}</span>`)
        : `<span class="mono">${esc(doc.original.number)}</span>`,
    ]);
  }
  // Codes (numbers, references) in mono; words (delivery terms, lead time) as text.
  for (const r of doc.refs) metaRows.push([esc(r.label), /^[A-Za-z0-9][A-Za-z0-9\-/._]*$/.test(r.value) ? `<span class="mono">${esc(r.value)}</span>` : `<span dir="auto">${esc(r.value)}</span>`]);

  const margin = doc.vat.treatment === 'MARGIN_SCHEME';
  // Margin scheme: the second-hand goods carry no separate VAT (marked *); a line that is a normal
  // supply (the shipping of margin goods, at the home rate) keeps its rate and its VAT row.
  const marginLine = (rateBp: number | null) => margin && !rateBp;
  const itemRows = doc.lines.map((l) => `
      <tr>
        <td class="desc">${u(l.description)}${l.detail ? u(l.detail, 'div', 'detail') : ''}</td>
        <td>${l.qty}</td>
        <td>${money(l.unitCents)}</td>
        <td>${marginLine(l.vatRateBp) ? '*' : fmtRate(l.vatRateBp)}</td>
        <td>${money(l.netCents)}</td>
      </tr>`).join('');

  const shownVatRows = margin ? doc.vat.rows.filter((r) => !marginLine(r.rateBp)) : doc.vat.rows;
  const vatRows = shownVatRows.map((r) => {
    const label = r.rateBp == null ? esc(L('VAT_ROW')) : `${esc(L('VAT_ROW'))} ${fmtRate(r.rateBp)}`;
    const over = margin || doc.vat.rows.length > 1 || r.rateBp === 0 ? `<tr><td class="sub" colspan="2">${esc(L('VAT_OVER'))} ${money(r.baseCents)}</td></tr>` : '';
    return `<tr><td>${label}</td><td>${money(r.taxCents)}</td></tr>${over}`;
  }).join('');
  // A short payment accepted within the tolerance: the total stays the invoiced
  // amount, so it is not "Total paid" — the payment box says what came in.
  const writtenOff = p?.kind === 'PAID' && (p.writtenOffCents ?? 0) > 0 ? p.writtenOffCents ?? 0 : 0;
  const totalLabel = isCredit ? L('TOTAL_CREDITED') : p?.kind === 'PAID' ? (writtenOff ? L('TOTAL') : L('TOTAL_PAID')) : p?.kind === 'PARTLY_PAID' ? L('TOTAL') : L('TOTAL_DUE');
  const totals = `
    <table class="totals">
      <tr><td>${esc(margin ? L('SUBTOTAL_MARGIN') : L('SUBTOTAL'))}</td><td>${money(doc.totals.netCents)}</td></tr>
      ${margin ? `${vatRows}<tr><td colspan="2" class="sub">${esc(L('MARGIN_NOTE'))}</td></tr>` : vatRows}
      <tr class="grand"><td>${esc(totalLabel)}</td><td>${money(doc.totals.totalCents)}</td></tr>
    </table>`;

  /** A label with {PLACEHOLDERS} → escaped HTML, values in bold. */
  const filled = (k: DocLabelKey, vars: Record<string, string>, bold: string[] = []): string => {
    const marks: Record<string, string> = {};
    for (const [key, v] of Object.entries(vars)) marks[key] = bold.includes(key) ? `\u0001${v}\u0002` : v;
    return esc(fillLabel(L(k), marks)).replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>');
  };

  let box = '<div></div>';
  if (p?.kind === 'INSTRUCTIONS') {
    const b = doc.bank;
    box = `<div class="box">
      <h3>${esc(L('BOX_INSTRUCTIONS'))}</h3>
      ${b && b.iban
        ? `<table>
            <tr><td>${esc(L('BENEFICIARY'))}</td><td dir="auto">${esc(b.beneficiary)}</td></tr>
            ${b.bankName ? `<tr><td>${esc(L('BANK'))}</td><td dir="auto">${esc(b.bankName)}</td></tr>` : ''}
            <tr><td>${esc(L('IBAN'))}</td><td class="mono" dir="ltr">${esc(b.iban)}</td></tr>
            ${b.bic ? `<tr><td>${esc(L('BIC'))}</td><td class="mono" dir="ltr">${esc(b.bic)}</td></tr>` : ''}
            <tr><td>${esc(L('REFERENCE'))}</td><td class="mono">${esc(p.reference)}</td></tr>
            <tr><td>${esc(L('AMOUNT'))}</td><td>${money(p.amountCents)}</td></tr>
            ${p.dueDate ? `<tr><td>${esc(L('PAY_BY'))}</td><td>${esc(day(p.dueDate))}</td></tr>` : ''}
          </table>`
        : `<p>${esc(fillLabel((doc.labels as Record<string, string> | undefined)?.NO_BANK_DETAILS ?? LEGACY_NO_BANK_DETAILS, { REFERENCE: '\u0001' })).replace('\u0001', `<strong class="mono">${esc(p.reference)}</strong>`)}</p>`}
    </div>`;
  } else if (p?.kind === 'PAID') {
    const paidLine = writtenOff
      ? filled('RECEIVED_WRITTEN_OFF', { PAID: money(p.amountCents ?? doc.totals.totalCents - writtenOff), DATE: p.paidAt ? date(p.paidAt) : '—', WRITTEN_OFF: money(writtenOff) }, ['PAID'])
      : `<strong>${esc(p.paidAt ? fillLabel(L('PAID_IN_FULL_ON'), { DATE: date(p.paidAt) }) : L('PAID_IN_FULL'))}</strong>`;
    box = `<div class="box paid">
      <h3>${esc(L('BOX_RECEIVED'))}</h3>
      <p>${paidLine}${p.method ? ` — ${esc(p.method)}` : ''}.</p>
      <p class="muted">${esc(L('NO_PAYMENT_DUE'))}</p>
    </div>`;
  } else if (p?.kind === 'DUE') {
    const b = doc.bank;
    box = `<div class="box">
      <h3>${esc(L('BOX_DUE'))}</h3>
      <p>${p.dueDate ? filled('DUE_LINE', { AMOUNT: money(p.amountCents), DATE: day(p.dueDate) }, ['AMOUNT', 'DATE']) : `<strong>${money(p.amountCents)}</strong>`}.</p>
      ${b && b.iban ? `<p class="muted">${esc(L('IBAN'))} <span class="mono" dir="ltr">${esc(b.iban)}</span>${b.bic ? ` · BIC <span class="mono" dir="ltr">${esc(b.bic)}</span>` : ''} · ${esc(L('REFERENCE').toLowerCase())} <span class="mono">${esc(p.reference)}</span></p>` : `<p class="muted">${esc(L('REFERENCE'))} <span class="mono">${esc(p.reference)}</span></p>`}
    </div>`;
  } else if (p?.kind === 'PARTLY_PAID') {
    const b = doc.bank;
    box = `<div class="box">
      <h3>${esc(L('BOX_DUE'))}</h3>
      <p>${filled('PARTLY_PAID_LINE', { PAID: money(p.paidCents), DATE: p.paidAt ? date(p.paidAt) : '—', OPEN: money(p.openCents) }, ['OPEN'])}</p>
      ${p.dueDate ? `<p>${filled('DUE_LINE', { AMOUNT: money(p.openCents), DATE: day(p.dueDate) }, ['AMOUNT', 'DATE'])}.</p>` : ''}
      ${b && b.iban ? `<p class="muted">${esc(L('IBAN'))} <span class="mono" dir="ltr">${esc(b.iban)}</span>${b.bic ? ` · BIC <span class="mono" dir="ltr">${esc(b.bic)}</span>` : ''} · ${esc(L('REFERENCE').toLowerCase())} <span class="mono">${esc(p.reference)}</span></p>` : `<p class="muted">${esc(L('REFERENCE'))} <span class="mono">${esc(p.reference)}</span></p>`}
    </div>`;
  } else if (p?.kind === 'CREDIT') {
    if (layout2) {
      box = `<div class="box void">
      <h3>${esc(L('BOX_CREDIT'))}</h3>
      <p>${esc(fillLabel(L('CREDIT_LINE'), { NUMBER: '\u0001' })).replace('\u0001', `<strong class="mono">${esc(p.originalNumber)}</strong>`)}</p>
    </div>`;
    } else {
      box = `<div class="box void">
      <h3>Credit note</h3>
      <p>This document credits invoice <strong class="mono">${esc(p.originalNumber)}</strong>. No payment is due.</p>
      ${p.refundMethod ? `<p class="muted">Refund by ${esc(p.refundMethod)}.</p>` : ''}
    </div>`;
    }
  }

  const legalBlock = doc.vat.legalText
    ? `<section class="vat-legal"><strong>${esc(L('VAT_LEGAL_PREFIX'))}</strong> ${esc(doc.vat.legalText)}${doc.vat.buyerVatId ? `\n${esc(L('CUSTOMER_VAT_ID'))}: ${esc(doc.vat.buyerVatId)}` : ''}</section>`
    : '';
  const pendingBlock = doc.vat.pendingNote ? `<section class="vat-pending">${esc(doc.vat.pendingNote)}</section>` : '';

  const legal = [
    esc(c.name),
    ...c.addressLines.map((l) => esc(l)),
    c.country ? esc(c.country) : '',
    c.kvk ? `${esc(L('FOOTER_KVK'))} ${esc(c.kvk)}` : '',
    c.vatId ? `${esc(L('FOOTER_VAT'))} ${esc(c.vatId)}` : '',
    doc.bank?.iban ? `IBAN ${esc(doc.bank.iban)}` : '',
    c.email ? esc(c.email) : '',
    c.web ? esc(c.web) : '',
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="${esc(loc.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${esc(doc.number)} — ${esc(c.name)}</title>
<style>${CSS}</style>
</head>
<body${[layout2 ? 'v2' : '', opts.compact ? 'compact' : ''].filter(Boolean).length ? ` class="${[layout2 ? 'v2' : '', opts.compact ? 'compact' : ''].filter(Boolean).join(' ')}"` : ''}>
<main class="sheet">
  <header class="top">
    <div class="brand">
      ${opts.logoDataUri ? `<img src="${opts.logoDataUri}" alt="${esc(c.name)}">` : `<div class="name" dir="auto">${esc(c.name)}</div>`}
    </div>
    <div class="doc-title">
      <h1>${esc(title)}</h1>
      <div class="no mono">${esc(doc.number)}</div>
      <span class="stamp ${STAMP_CLASS[stampKey]}">${esc(stampLabel)}</span>
    </div>
  </header>

  <section class="head">
    <div class="from">
      <div class="strong" dir="auto">${esc(c.name)}</div>
      ${companyLines}
      <div class="muted" style="margin-top:4px;">${companyIds}</div>
    </div>
    <table class="meta">
      ${metaRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
    </table>
  </section>

  <section class="parties">
    ${party(esc(L('BILL_TO')), doc.buyer, '')}
    ${party(esc(L('SHIP_TO')), doc.shipTo, esc(L('SHIP_TO_PENDING')))}
  </section>

  <table class="items">
    <thead>
      <tr><th>${esc(L('COL_DESCRIPTION'))}</th><th>${esc(L('COL_QTY'))}</th><th>${esc(L('COL_UNIT'))}</th><th>${esc(L('COL_VAT'))}</th><th>${esc(L('COL_AMOUNT'))}</th></tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <section class="summary">
    ${box}
    ${totals}
  </section>

  ${legalBlock}
  ${pendingBlock}

  ${[...(doc.remarks ?? []).map((n) => noteBlock(L('REMARK'), n)), ...doc.notes.map((n) => noteBlock(L('NOTE'), n))].join('')}

  ${doc.terms.length ? `<ul class="terms">${doc.terms.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
  ${doc.clauses.length ? `<div class="clauses">${doc.clauses.map((t) => `<p>${esc(t)}</p>`).join('')}</div>` : ''}

  <footer class="legal">${legal}${doc.footerExtra ? `<br>${esc(doc.footerExtra)}` : ''}</footer>
</main>
</body>
</html>`;
}
