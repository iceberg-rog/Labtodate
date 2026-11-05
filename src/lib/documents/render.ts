import { escapeHtml as esc } from '@/lib/email-html';
import { fillPlain, fillRich } from '@/lib/cms/text';
import type { DocSnapshot } from './types';
import { docVars, fmtDate, fmtMoney, fmtNumber, methodLabel } from './vars';

/**
 * The ONE renderer for quotes, invoices and receipts: a complete,
 * self-contained A4 HTML page (inline CSS, no scripts, logo as data: URI)
 * made ONLY from a snapshot. The PDF, the admin live preview and the
 * customer's on-screen copy all come from this HTML, so they cannot differ.
 * Every value that came from a person is escaped and bidi-isolated.
 */

function u(value: string | null | undefined, tag = 'div', cls = ''): string {
  if (!value || !value.trim()) return '';
  return `<${tag} dir="auto"${cls ? ` class="${cls}"` : ''}>${esc(value)}</${tag}>`;
}

function css(accent: string): string {
  return `
  @page { size: A4; margin: 12mm 15mm 16mm 15mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, 'Liberation Sans', 'DejaVu Sans', Helvetica, sans-serif; font-size: 9.5pt; color: #111827; line-height: 1.4; background: #fff; }
  .doc { max-width: 180mm; margin: 0 auto; }
  .muted { color: #6b7280; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
  .logo img { max-height: 18mm; max-width: 70mm; display: block; }
  .logo .name { font-size: 18pt; font-weight: 800; letter-spacing: -0.02em; color: ${accent}; }
  .company { text-align: right; font-size: 8.5pt; line-height: 1.5; }
  .company .cname { font-weight: 700; font-size: 9.5pt; }
  .company table { margin-left: auto; border-collapse: collapse; }
  .company td { padding: 0 0 0 3mm; vertical-align: top; }
  .company td.k { color: #6b7280; text-align: right; }
  .titlebar { display: flex; align-items: center; gap: 4mm; margin: 7mm 0 5mm; border-bottom: 2px solid ${accent}; padding-bottom: 2.5mm; }
  h1 { font-size: 18pt; margin: 0; color: ${accent}; letter-spacing: -0.01em; }
  .stamp { font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 1mm 2.5mm; border-radius: 1.5mm; border: 1px solid; }
  .stamp.paid { color: #065f46; border-color: #6ee7b7; background: #ecfdf5; }
  .stamp.due { color: #92400e; border-color: #fcd34d; background: #fffbeb; }
  .stamp.void { color: #991b1b; border-color: #fca5a5; background: #fef2f2; }
  .stamp.preview { color: #1e40af; border-color: #93c5fd; background: #eff6ff; }
  .parties { display: flex; justify-content: space-between; gap: 10mm; margin-bottom: 5mm; }
  .party { flex: 1 1 55%; overflow-wrap: anywhere; }
  .party .h { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 1mm; }
  .party .pn { font-weight: 700; font-size: 10.5pt; }
  .meta { flex: 0 0 72mm; border-collapse: collapse; font-size: 9pt; align-self: flex-start; }
  .meta td { padding: 0.8mm 0; vertical-align: top; }
  .meta td.k { color: #6b7280; padding-right: 4mm; white-space: nowrap; }
  .meta td.v { font-weight: 700; text-align: right; overflow-wrap: anywhere; }
  .text p { margin: 0 0 2mm; }
  .text ul { margin: 0 0 2.5mm 5mm; padding: 0; }
  table.lines { width: 100%; border-collapse: collapse; margin: 3mm 0 0; }
  table.lines th { background: #f3f4f6; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; text-align: left; padding: 2mm; border-bottom: 1px solid #d1d5db; }
  table.lines td { padding: 1.8mm 2mm; border-bottom: 1px solid #e5e7eb; vertical-align: top; overflow-wrap: anywhere; }
  table.lines .num { text-align: right; white-space: nowrap; }
  table.lines .detail { color: #6b7280; font-size: 8.5pt; margin-top: 0.6mm; }
  tr { page-break-inside: avoid; }
  .bottom { display: flex; justify-content: space-between; gap: 10mm; margin-top: 3mm; page-break-inside: avoid; }
  .legal { flex: 1 1 auto; font-size: 8.5pt; color: #374151; }
  .totals { flex: 0 0 75mm; border-collapse: collapse; font-size: 9.5pt; }
  .totals td { padding: 1mm 2mm; }
  .totals td.v { text-align: right; white-space: nowrap; }
  .totals tr.sum td { border-top: 1.5px solid #111827; font-weight: 700; font-size: 11pt; padding-top: 2mm; }
  .box { border: 1px solid #d1d5db; border-radius: 2mm; padding: 2.5mm 4mm; margin-top: 4mm; page-break-inside: avoid; font-size: 9pt; }
  .box .bh { font-weight: 700; margin-bottom: 1.5mm; }
  .box table { border-collapse: collapse; }
  .box td { padding: 0.6mm 6mm 0.6mm 0; vertical-align: top; }
  .box td.k { color: #6b7280; }
  .box.paid { border-color: #6ee7b7; background: #ecfdf5; color: #065f46; }
  .box.paid td.k { color: #047857; }
  .mono { font-family: Consolas, 'DejaVu Sans Mono', Menlo, monospace; }
  .note { margin-top: 4mm; background: #f9fafb; border-left: 3px solid #94a3b8; padding: 2.5mm 4mm; font-size: 9pt; white-space: pre-wrap; overflow-wrap: anywhere; }
  .sign { display: flex; gap: 10mm; margin-top: 6mm; page-break-inside: avoid; font-size: 9.5pt; }
  .sign > div:first-child { flex: 0 0 55mm; }
  .sign > div:last-child { flex: 1; }
  .sign .fields { display: flex; gap: 5mm; }
  .sign .fields > div { flex: 1; }
  .sign .fields > div.wide { flex: 1.6; }
  .sign .line { border-bottom: 1px solid #111827; height: 10mm; }
  .sign .lbl { color: #6b7280; font-size: 8pt; margin-top: 1mm; }
  .foot { margin-top: 6mm; padding-top: 2.5mm; border-top: 1px solid #e5e7eb; font-size: 7.5pt; color: #6b7280; }
  .foot p { margin: 0 0 1mm; }
  @media screen { body { padding: 10mm 0; } }
`;
}

export function renderDocumentHtml(snap: DocSnapshot): string {
  const L = snap.lang;
  const T = snap.texts;
  const B = snap.labels;
  const O = snap.options;
  const vars = docVars(snap);
  const money = (c: number) => fmtMoney(c, snap.currency, L);
  const rich = (t: string) => fillRich(t, vars);
  const plain = (t: string) => esc(fillPlain(t, vars));
  const c = snap.company;
  const isInvoice = snap.kind === 'INVOICE';
  const isQuote = snap.kind === 'QUOTE';
  const isReceipt = snap.kind === 'RECEIPT';
  const unpaidInvoice = isInvoice && !snap.paid;

  const title = unpaidInvoice && T.titleUnpaid ? T.titleUnpaid : T.title;
  let stamp = '';
  if (snap.voided) stamp = `<span class="stamp void">${esc(B.voidStamp)}</span>`;
  else if (snap.preview && isInvoice && !snap.number) stamp = '';
  else if (unpaidInvoice && T.stampUnpaid) stamp = `<span class="stamp due">${plain(T.stampUnpaid)}</span>`;
  else if ((isInvoice || isReceipt) && snap.paid && T.stamp) stamp = `<span class="stamp paid">${plain(T.stamp)}</span>`;
  else if (T.stamp) stamp = `<span class="stamp due">${plain(T.stamp)}</span>`;

  // ── header: logo + company block
  const logo = O.showLogo && c.logo
    ? `<img src="${esc(c.logo)}" alt="${esc(c.name)}">`
    : `<div class="name" dir="auto">${esc(c.name)}</div>`;
  const companyRows: string[] = [];
  const crow = (k: string, v: string, mono = false) => {
    if (v && v.trim()) companyRows.push(`<tr><td class="k">${esc(k)}</td><td${mono ? ' class="mono"' : ''} dir="auto">${esc(v)}</td></tr>`);
  };
  crow(B.companyPhone, c.phone);
  crow(B.companyEmail, c.email);
  crow(B.companyWeb, c.web);
  crow(B.companyKvk, c.kvk);
  crow(B.companyVat, c.vat, true);
  if (c.iban) crow(B.iban, c.iban, true);
  if (c.iban && c.bic) crow(B.bic, c.bic, true);
  const companyBlock = `
    <div class="company">
      <div class="cname" dir="auto">${esc(c.name)}</div>
      ${c.addressLines.map((l) => u(l)).join('')}
      ${companyRows.length ? `<table style="margin-top:1.5mm">${companyRows.join('')}</table>` : ''}
    </div>`;

  // ── customer + meta
  const cust = snap.customer;
  const custHead = cust.company && cust.company.trim() ? cust.company : cust.name;
  const customerBlock = `
    <div class="party">
      <div class="h">${esc(isQuote ? B.preparedFor : B.billTo)}</div>
      ${u(custHead, 'div', 'pn')}
      ${cust.company && cust.name && cust.name !== cust.company ? u(cust.name) : ''}
      ${cust.addressLines.length ? cust.addressLines.map((l) => u(l)).join('') : u(cust.email)}
      ${cust.vatId ? `<div>${esc(B.customerVat)}: <span class="mono">${esc(cust.vatId)}</span></div>` : ''}
      ${snap.shipTo && snap.shipTo.length ? `<div class="h" style="margin-top:3mm">${esc(B.shipTo)}</div>${snap.shipTo.map((l) => u(l)).join('')}` : ''}
    </div>`;
  const metaRows: string[] = [];
  const mrow = (k: string, v: string | null | undefined) => {
    if (v && String(v).trim()) metaRows.push(`<tr><td class="k">${esc(k)}</td><td class="v" dir="auto">${esc(v)}</td></tr>`);
  };
  mrow(T.numberLabel, snap.number + (snap.revision > 1 ? ` (rev. ${snap.revision})` : ''));
  mrow(B.date, `${c.city && isQuote ? `${c.city}, ` : ''}${fmtDate(snap.issuedAt, L, snap.timeZone)}`);
  if (isQuote) mrow(B.validUntil, fmtDate(snap.validUntil, L, 'UTC'));
  if (unpaidInvoice) mrow(B.dueDate, fmtDate(snap.dueDate, L, 'UTC'));
  if (O.showCustomerNo) mrow(B.customerNo, cust.number);
  if (!isQuote) mrow(B.orderNo, snap.refs.orderNumber);
  if (!isQuote && snap.refs.quoteNumber) mrow(B.quoteRef, snap.refs.quoteNumber);
  if (isReceipt) mrow(B.invoiceRef, snap.refs.invoiceNumber);
  const metaBlock = `<table class="meta">${metaRows.join('')}</table>`;

  // ── greeting + intro
  const greet = O.showGreeting
    ? (cust.name && cust.name.trim() ? fillPlain(T.greeting, vars) : fillPlain(T.greetingFallback, vars))
    : '';
  const introBlock = `${greet.trim() ? `<p>${esc(greet)}</p>` : ''}${rich(T.intro)}`;

  // ── lines
  const lineRows = snap.lines.map((l) => `
      <tr>
        <td><div dir="auto">${esc(l.title)}</div>${l.detail ? `<div class="detail" dir="auto">${esc(l.detail)}</div>` : ''}</td>
        <td class="num">${esc(fmtNumber(l.qty, L))}</td>
        <td class="num">${esc(money(l.unitCents))}</td>
        <td class="num">${esc(money(Math.round(l.unitCents * l.qty)))}</td>
      </tr>`).join('');
  const shippingRow = snap.shippingCents > 0
    ? `<tr><td>${esc(B.shipping)}</td><td class="num">1</td><td class="num">${esc(money(snap.shippingCents))}</td><td class="num">${esc(money(snap.shippingCents))}</td></tr>`
    : '';

  // ── VAT legal text + totals
  const legalParts: string[] = [];
  if (snap.vat.treatment === 'REVERSE_CHARGE') legalParts.push(rich(B.legalReverseCharge));
  if (snap.vat.treatment === 'EXPORT') legalParts.push(rich(B.legalExport));
  const vatLabel = snap.vat.rateBp === 0 && snap.vat.treatment !== 'LEGACY' ? B.vatRowZero : B.vatRow;
  const paid = (isInvoice && snap.paid) || isReceipt;
  const totals = `
    <table class="totals">
      <tr><td>${esc(B.subtotal)}</td><td class="v">${esc(money(snap.subtotalCents + snap.shippingCents))}</td></tr>
      <tr><td>${plain(vatLabel)}</td><td class="v">${esc(money(snap.vat.cents))}</td></tr>
      <tr class="sum"><td>${esc(paid || isQuote ? B.total : B.totalDue)}</td><td class="v">${esc(money(snap.totalCents))}</td></tr>
    </table>`;

  // ── payment box
  let paymentBox = '';
  if (isQuote || unpaidInvoice) {
    if (O.showBankDetails) {
      const rows: string[] = [];
      const prow = (k: string, v: string, mono = false) => {
        if (v && v.trim()) rows.push(`<tr><td class="k">${esc(k)}</td><td${mono ? ' class="mono"' : ''} dir="auto"><strong>${esc(v)}</strong></td></tr>`);
      };
      prow(B.amountDue, money(snap.totalCents));
      if (unpaidInvoice) prow(B.payBefore, fmtDate(snap.dueDate, L, 'UTC'));
      if (c.iban) {
        prow(B.iban, c.iban, true);
        prow(B.beneficiary, c.name);
        prow(B.bic, c.bic, true);
        prow(B.bank, c.bank);
        prow(B.reference, snap.number, true);
      }
      paymentBox = `
        <div class="box">
          <div class="bh">${esc(B.paymentDetails)}</div>
          <table>${rows.join('')}</table>
          ${c.iban ? '' : `<div style="margin-top:1.5mm;color:#92400e">${esc(B.noBankDetails)}</div>`}
        </div>`;
    }
  } else if (paid) {
    const rows: string[] = [];
    const prow = (k: string, v: string) => {
      if (v && v.trim()) rows.push(`<tr><td class="k">${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`);
    };
    prow(B.paidOn, fmtDate(snap.paidAt, L, snap.timeZone));
    prow(B.amountPaid, money(snap.totalCents));
    prow(B.paymentMethod, methodLabel(snap));
    prow(B.reference, isReceipt ? (snap.refs.invoiceNumber || snap.number) : snap.number);
    paymentBox = `<div class="box paid"><div class="bh">${esc(B.paidBox)}</div><table>${rows.join('')}</table></div>`;
  }

  const termsBlock = (isQuote || unpaidInvoice) && T.paymentTerms ? `<div class="text" style="margin-top:4mm">${rich(T.paymentTerms)}</div>` : '';
  const closingBlock = T.closing ? `<div class="text" style="margin-top:3mm">${rich(T.closing)}</div>` : '';
  const noteBlock = snap.note && snap.note.trim() ? `<div class="note" dir="auto">${esc(snap.note.trim())}</div>` : '';
  const signBlock = isQuote && O.showSignature ? `
    <div class="sign">
      <div>
        <div>${esc(B.signGreeting)}</div>
        <div style="font-weight:700;margin-top:1mm" dir="auto">${esc(c.name)}</div>
      </div>
      <div>
        <div style="font-weight:700">${esc(B.signAgreed)}</div>
        <div class="fields">
          <div class="wide"><div class="line"></div><div class="lbl">${esc(B.signName)}</div></div>
          <div><div class="line"></div><div class="lbl">${esc(B.signDate)}</div></div>
          <div class="wide"><div class="line"></div><div class="lbl">${esc(B.signSignature)}</div></div>
        </div>
      </div>
    </div>` : '';
  const footBlock = T.footer && T.footer.trim() ? `<div class="foot">${rich(T.footer)}</div>` : '';

  return `<!doctype html>
<html lang="${L}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${title} ${snap.number}`)}</title>
<style>${css(snap.accent)}</style>
</head>
<body>
<div class="doc">
  <div class="head"><div class="logo">${logo}</div>${companyBlock}</div>
  <div class="titlebar"><h1 dir="auto">${esc(title)}</h1>${stamp}${snap.preview ? '<span class="stamp preview">Preview</span>' : ''}</div>
  <div class="parties">${customerBlock}${metaBlock}</div>
  <div class="text">${introBlock}</div>
  <table class="lines">
    <thead><tr><th>${esc(B.colDescription)}</th><th class="num" style="width:16mm">${esc(B.colQty)}</th><th class="num" style="width:30mm">${esc(B.colUnit)}</th><th class="num" style="width:30mm">${esc(B.colAmount)}</th></tr></thead>
    <tbody>${lineRows}${shippingRow}</tbody>
  </table>
  <div class="bottom"><div class="legal">${legalParts.join('')}</div>${totals}</div>
  ${paymentBox}
  ${termsBlock}
  ${noteBlock}
  ${closingBlock}
  ${signBlock}
  ${footBlock}
</div>
</body>
</html>`;
}

/** Footer line printed by Chromium on every page (company name + page x of y). */
export function pdfFooter(snap: DocSnapshot): { footerText: string; pageLabel: string } {
  return {
    footerText: `${snap.company.name} · ${snap.texts.title} ${snap.number}`,
    pageLabel: snap.labels.page || 'Page {PAGE} of {PAGES}',
  };
}
