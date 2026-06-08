export interface InvoiceLine {
  title: string;
  qty: number;
  unitCents: number;
}

export interface InvoiceInput {
  kind: 'INVOICE' | 'PROFORMA';
  number: string;
  dateISO: string;
  currency: string;
  buyer: { name: string; email: string; company?: string | null };
  buyerAddress?: string | null;
  buyerVatNumber?: string | null;
  clientNumber?: string | number | null;
  lines: InvoiceLine[];
  shippingCents?: number;
  taxCents?: number;
  status?: string;
  note?: string | null;
  shipTo?: string | null;
  dueDateISO?: string | null;
  paymentTermDays?: number | null;
  deliveryDateISO?: string | null;
  validUntilISO?: string | null;
}

// Resolved at render time so admin Settings → Company / Payments / Logo
// changes take effect on the next request (DB → process.env via
// ensureSettingsLoaded — callers invoke that before renderInvoiceHtml).
function getCompany() {
  const addr = (process.env.COMPANY_ADDRESS || '').trim();
  const addrLines = addr ? addr.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean) : [];
  return {
    name: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'lab2date',
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

function logoUrl(logoPath: string): string {
  if (!logoPath) return '';
  if (/^https?:\/\//i.test(logoPath)) return logoPath;
  const origin = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  return origin ? `${origin}${logoPath.startsWith('/') ? '' : '/'}${logoPath}` : logoPath;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function nl(v: number): string {
  return v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateNL(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

export function renderInvoiceHtml(inv: InvoiceInput): { subject: string; html: string } {
  const COMPANY = getCompany();
  const isProforma = inv.kind === 'PROFORMA';
  const cur = inv.currency || 'EUR';
  const symbol = cur === 'EUR' ? '€' : cur;
  const subtotal = inv.lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  const tax = inv.taxCents ?? 0;
  const shipping = inv.shippingCents ?? 0;
  const total = subtotal + shipping + tax;
  const docDate = dateNL(inv.dateISO);
  const docTitle = isProforma ? 'Offerte' : 'Factuur';
  const totalLabel = isProforma ? 'Offertebedrag' : 'Te betalen';

  const itemRows = inv.lines.map((l) => `
    <tr>
      <td style="padding:9px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;">${esc(l.title)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;white-space:nowrap;">${nl(l.qty)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;white-space:nowrap;">${nl(l.unitCents / 100)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;white-space:nowrap;">${nl((l.unitCents * l.qty) / 100)}</td>
    </tr>`).join('');

  const buyerLines: string[] = [];
  const header = inv.buyer.company || inv.buyer.name;
  buyerLines.push(`<div style="font-weight:700;font-size:14px;">${esc(header)}</div>`);
  if (inv.buyer.company && inv.buyer.name && inv.buyer.name !== inv.buyer.company) {
    buyerLines.push(`<div style="font-size:13px;color:#374151;">${esc(inv.buyer.name)}</div>`);
  }
  if (inv.buyerAddress) {
    inv.buyerAddress.split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((ln) => {
      buyerLines.push(`<div style="font-size:13px;color:#374151;">${esc(ln)}</div>`);
    });
  } else {
    buyerLines.push(`<div style="font-size:13px;color:#6b7280;">${esc(inv.buyer.email)}</div>`);
  }
  const buyerBlock = buyerLines.join('');

  const companyAddrRows = (COMPANY.addrLines.length ? COMPANY.addrLines : [''])
    .concat(COMPANY.country ? [COMPANY.country] : [])
    .map((line, i, arr) =>
      `<tr><td colspan="2"${i === arr.length - 1 ? ' style="padding-bottom:8px;"' : ''}>${esc(line)}</td></tr>`,
    ).join('');
  const companyHeaderCell = `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111827;line-height:1.45;">
      <tr><td colspan="2" style="font-weight:700;font-size:13px;padding-bottom:2px;">${esc(COMPANY.name)}</td></tr>
      ${companyAddrRows}
      ${COMPANY.phone ? `<tr><td style="font-weight:700;padding-right:8px;">t</td><td>${esc(COMPANY.phone)}</td></tr>` : ''}
      ${COMPANY.email ? `<tr><td style="font-weight:700;padding-right:8px;">e</td><td>${esc(COMPANY.email)}</td></tr>` : ''}
      ${COMPANY.web ? `<tr><td style="font-weight:700;padding-right:8px;padding-bottom:10px;">i</td><td style="padding-bottom:10px;">${esc(COMPANY.web)}</td></tr>` : ''}
      ${COMPANY.iban ? `<tr><td style="font-weight:700;padding-right:12px;">IBAN</td><td style="font-family:Consolas,Menlo,monospace;">${esc(COMPANY.iban)}</td></tr>` : ''}
      ${COMPANY.bic ? `<tr><td style="font-weight:700;padding-right:12px;">BIC</td><td style="font-family:Consolas,Menlo,monospace;">${esc(COMPANY.bic)}</td></tr>` : ''}
      ${COMPANY.vat ? `<tr><td style="font-weight:700;padding-right:12px;">Btw-nr</td><td style="font-family:Consolas,Menlo,monospace;">${esc(COMPANY.vat)}</td></tr>` : ''}
      ${COMPANY.kvk ? `<tr><td style="font-weight:700;padding-right:12px;">KvK</td><td>${esc(COMPANY.kvk)}</td></tr>` : ''}
    </table>`;

  const metaCell = isProforma ? `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111827;">
      <tr>
        <td style="color:#6b7280;padding-bottom:2px;">Offertenummer</td>
        <td style="color:#6b7280;padding-bottom:2px;">${inv.clientNumber ? 'Relatienummer' : ''}</td>
        <td style="color:#6b7280;padding-bottom:2px;text-align:right;">&nbsp;</td>
      </tr>
      <tr>
        <td style="font-weight:700;padding-right:24px;">${esc(inv.number)}</td>
        <td style="font-weight:700;padding-right:24px;">${inv.clientNumber ? esc(String(inv.clientNumber)) : ''}</td>
        <td style="text-align:right;">${COMPANY.city ? `${esc(COMPANY.city)}, ` : ''}<strong>${docDate}</strong></td>
      </tr>
    </table>` : `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111827;">
      <tr><td style="color:#6b7280;padding:2px 12px 2px 0;">Factuurnummer</td><td style="font-weight:700;text-align:right;">${esc(inv.number)}</td></tr>
      <tr><td style="color:#6b7280;padding:2px 12px 2px 0;">Factuurdatum</td><td style="font-weight:700;text-align:right;">${docDate}</td></tr>
      ${inv.paymentTermDays ? `<tr><td style="color:#6b7280;padding:2px 12px 2px 0;">Betalingstermijn</td><td style="font-weight:700;text-align:right;">${inv.paymentTermDays} dagen</td></tr>` : ''}
      ${inv.clientNumber ? `<tr><td style="color:#6b7280;padding:2px 12px 2px 0;padding-top:8px;">Klantnummer</td><td style="font-weight:700;text-align:right;padding-top:8px;">${esc(String(inv.clientNumber))}</td></tr>` : ''}
      ${inv.deliveryDateISO ? `<tr><td style="color:#6b7280;padding:2px 12px 2px 0;">Leverdatum</td><td style="font-weight:700;text-align:right;">${dateNL(inv.deliveryDateISO)}</td></tr>` : ''}
    </table>`;

  const factuurPaymentBox = !isProforma ? `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111827;border:1px solid #d1d5db;border-radius:6px;padding:0;width:100%;max-width:380px;">
      <tr><td style="padding:12px 16px 4px 16px;font-weight:700;">Betaalgegevens</td></tr>
      <tr><td style="padding:0 16px 12px 16px;">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-size:12px;">
          <tr><td style="color:#6b7280;padding:3px 12px 3px 0;">Te betalen</td><td style="font-weight:700;">${symbol} ${nl(total / 100)}${inv.dueDateISO ? ` <span style="font-weight:400;color:#6b7280;">(voor ${dateNL(inv.dueDateISO)})</span>` : ''}</td></tr>
          <tr><td style="color:#6b7280;padding:3px 12px 3px 0;">Naar IBAN</td><td style="font-weight:700;font-family:Consolas,Menlo,monospace;">${esc(COMPANY.iban)}</td></tr>
          <tr><td style="color:#6b7280;padding:3px 12px 3px 0;">Op naam van</td><td style="font-weight:700;">${esc(COMPANY.name)}</td></tr>
          <tr><td style="color:#6b7280;padding:3px 12px 3px 0;">Omschrijving</td><td style="font-weight:700;">Factuur ${esc(inv.number)}</td></tr>
        </table>
      </td></tr>
    </table>` : '';

  const vatNote = inv.buyerVatNumber ? `
    Btw verlegd, betreft intracommunautaire prestatie conform artikel 138, lid 1, Richtlijn 2006/112.<br>
    Uw btw-nummer is ${esc(inv.buyerVatNumber)}.
  ` : '';

  const totalsTable = `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111827;width:100%;max-width:320px;">
      <tr>
        <td style="padding:5px 8px;color:#374151;">Totaal excl. btw</td>
        <td style="padding:5px 4px;text-align:right;color:#374151;width:14px;">${symbol}</td>
        <td style="padding:5px 8px;text-align:right;">${nl(subtotal / 100)}</td>
      </tr>
      <tr>
        <td style="padding:5px 8px;color:#374151;border-bottom:1px solid #111827;">Totaal btw</td>
        <td style="padding:5px 4px;text-align:right;color:#374151;border-bottom:1px solid #111827;">${symbol}</td>
        <td style="padding:5px 8px;text-align:right;border-bottom:1px solid #111827;">${nl(tax / 100)}</td>
      </tr>
      <tr>
        <td style="padding:9px 8px;font-weight:700;">${totalLabel}</td>
        <td style="padding:9px 4px;text-align:right;font-weight:700;">${symbol}</td>
        <td style="padding:9px 8px;text-align:right;font-weight:700;">${nl(total / 100)}</td>
      </tr>
    </table>`;

  const proformaSignature = isProforma ? `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111827;margin-top:24px;">
      <tr>
        <td style="vertical-align:top;width:50%;padding-right:20px;">
          <div>Met vriendelijke groet,</div>
          <div style="font-weight:700;margin-top:2px;">${esc(COMPANY.name)}</div>
        </td>
        <td style="vertical-align:top;width:50%;">
          <table cellpadding="0" cellspacing="0" border="0" style="font-size:12px;">
            <tr><td style="font-weight:700;padding-right:12px;padding-bottom:14px;">Voor akkoord:</td><td style="padding-bottom:14px;">${esc(inv.buyer.company || inv.buyer.name)}</td></tr>
            <tr><td style="font-weight:700;padding-right:12px;padding-bottom:14px;">Datum</td><td style="border-bottom:1px solid #111827;width:180px;height:16px;padding-bottom:14px;">&nbsp;</td></tr>
            <tr><td style="font-weight:700;padding-right:12px;">Handtekening</td><td style="border-bottom:1px solid #111827;width:180px;height:16px;">&nbsp;</td></tr>
          </table>
        </td>
      </tr>
    </table>
  ` : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:0 auto;color:#111827;background:#ffffff;">
    <!-- HEADER -->
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
      <tr>
        <td style="vertical-align:top;width:55%;padding-right:24px;">
          ${COMPANY.logoPath
            ? `<img src="${esc(logoUrl(COMPANY.logoPath))}" alt="${esc(COMPANY.name)}" style="max-height:90px;max-width:280px;display:block;border:0;outline:none;" />`
            : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#0E4F40;">${esc(COMPANY.name)}</div>`}
        </td>
        <td style="vertical-align:top;width:45%;">${companyHeaderCell}</td>
      </tr>
    </table>

    <!-- TITLE + CUSTOMER -->
    <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;margin:32px 0 14px 0;color:#111827;">${docTitle}</h1>
    <div style="margin-bottom:24px;">${buyerBlock}</div>

    <!-- META -->
    <div style="margin-bottom:18px;">${metaCell}</div>

    ${!isProforma ? `<div style="margin:0 0 18px 0;">${factuurPaymentBox}</div>` : ''}

    ${isProforma ? `
      <p style="font-size:13px;margin:18px 0 6px 0;">Dear Sir/Madam,</p>
      <p style="font-size:13px;margin:0 0 18px 0;">Thank you for your quote request. We can provide the work and/or supplies discussed at the price listed in this quote.</p>
    ` : ''}

    <!-- ITEMS -->
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;margin-top:6px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:9px 8px;text-align:left;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #e5e7eb;">Omschrijving</th>
          <th style="padding:9px 8px;text-align:right;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #e5e7eb;width:80px;">Aantal</th>
          <th style="padding:9px 8px;text-align:right;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #e5e7eb;width:100px;">Prijs</th>
          <th style="padding:9px 8px;text-align:right;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #e5e7eb;width:110px;">Totaal</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <!-- VAT NOTE + TOTALS -->
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:36px;">
      <tr>
        <td style="vertical-align:top;width:55%;padding-right:24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#374151;line-height:1.55;">
          ${vatNote}
        </td>
        <td style="vertical-align:top;width:45%;">${totalsTable}</td>
      </tr>
    </table>

    ${isProforma ? `
      <div style="margin-top:28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#374151;line-height:1.55;">
        We hope we&apos;ve made you a suitable offer. If you have any questions or comments, please let us know.<br>
        <strong>Payment Terms:</strong> Full payment due before delivery
      </div>
      ${proformaSignature}
    ` : ''}

    ${inv.note ? `<div style="margin-top:18px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#374151;background:#f9fafb;border-left:3px solid #94a3b8;padding:10px 14px;">${esc(inv.note).replace(/\n/g, '<br>')}</div>` : ''}
  </div>`;

  const subject = `${docTitle} ${inv.number} — ${COMPANY.name}`;
  return { subject, html };
}
