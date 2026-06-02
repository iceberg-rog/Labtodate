import { formatPrice } from '@/lib/utils';

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
  lines: InvoiceLine[];
  shippingCents?: number;
  taxCents?: number;
  status?: string; // e.g. PAID / Awaiting payment
  note?: string | null;
  shipTo?: string | null;
}

/** Reads company identity from process.env (call ensureSettingsLoaded first). */
function company() {
  // Logos in emails must be absolute; our media URLs are host-relative.
  const rawLogo = process.env.COMPANY_LOGO_URL || '';
  const origin = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  const logo = rawLogo && rawLogo.startsWith('/') ? `${origin}${rawLogo}` : rawLogo;
  return {
    name: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'lab2date',
    address: process.env.COMPANY_ADDRESS || '',
    country: process.env.COMPANY_COUNTRY || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || process.env.SUPPORT_EMAIL || '',
    vat: process.env.COMPANY_VAT || '',
    logo,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderInvoiceHtml(inv: InvoiceInput): { subject: string; html: string } {
  const c = company();
  const cur = inv.currency || 'EUR';
  const subtotal = inv.lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  const shipping = inv.shippingCents ?? 0;
  const tax = inv.taxCents ?? 0;
  const total = subtotal + shipping + tax;
  const isProforma = inv.kind === 'PROFORMA';
  const title = isProforma ? 'PROFORMA INVOICE' : 'INVOICE';
  const date = new Date(inv.dateISO).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const rows = inv.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;">${esc(l.title)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:center;">${l.qty}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;">${formatPrice(l.unitCents, cur)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;">${formatPrice(l.unitCents * l.qty, cur)}</td>
      </tr>`,
    )
    .join('');

  const totalsRow = (label: string, val: string, bold = false) => `
    <tr>
      <td colspan="2"></td>
      <td style="padding:6px 8px;text-align:right;${bold ? 'font-weight:700;border-top:2px solid #0E4F40;' : 'color:#666;'}">${label}</td>
      <td style="padding:6px 8px;text-align:right;${bold ? 'font-weight:700;border-top:2px solid #0E4F40;' : ''}">${val}</td>
    </tr>`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0E4F40;padding-bottom:16px;">
      <div>
        ${c.logo ? `<img src="${esc(c.logo)}" alt="${esc(c.name)}" style="max-height:48px;max-width:200px;display:block;margin-bottom:8px;" />` : ''}
        <div style="font-size:22px;font-weight:800;color:#0E4F40;letter-spacing:-0.02em;">${esc(c.name)}</div>
        ${c.address ? `<div style="font-size:12px;color:#555;margin-top:4px;">${esc(c.address)}${c.country ? ', ' + esc(c.country) : ''}</div>` : ''}
        ${c.vat ? `<div style="font-size:12px;color:#555;">VAT / Reg: ${esc(c.vat)}</div>` : ''}
        ${c.phone ? `<div style="font-size:12px;color:#555;">${esc(c.phone)}</div>` : ''}
        ${c.email ? `<div style="font-size:12px;color:#555;">${esc(c.email)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:20px;font-weight:800;letter-spacing:0.04em;">${title}</div>
        <div style="font-size:13px;color:#555;margin-top:6px;">No. <strong>${esc(inv.number)}</strong></div>
        <div style="font-size:13px;color:#555;">Date: ${date}</div>
        ${inv.status ? `<div style="font-size:12px;margin-top:4px;font-weight:700;color:${inv.status.toUpperCase().includes('PAID') ? '#0a7d3f' : '#b06a00'};">${esc(inv.status)}</div>` : ''}
      </div>
    </div>

    <div style="margin:18px 0;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#888;font-weight:700;">Billed to</div>
      <div style="font-size:14px;font-weight:600;margin-top:4px;">${esc(inv.buyer.name)}</div>
      ${inv.buyer.company ? `<div style="font-size:13px;color:#555;">${esc(inv.buyer.company)}</div>` : ''}
      <div style="font-size:13px;color:#555;">${esc(inv.buyer.email)}</div>
    </div>

    ${
      inv.shipTo
        ? `<div style="margin:0 0 18px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#888;font-weight:700;">Ship to</div>
      <div style="font-size:13px;color:#555;margin-top:4px;">${esc(inv.shipTo)}</div>
    </div>`
        : ''
    }

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f4f6f5;">
          <th style="padding:10px 8px;text-align:left;">Description</th>
          <th style="padding:10px 8px;text-align:center;">Qty</th>
          <th style="padding:10px 8px;text-align:right;">Unit</th>
          <th style="padding:10px 8px;text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${totalsRow('Subtotal', formatPrice(subtotal, cur))}
        ${shipping ? totalsRow('Shipping', formatPrice(shipping, cur)) : ''}
        ${tax ? totalsRow('Tax', formatPrice(tax, cur)) : ''}
        ${totalsRow('Total', formatPrice(total, cur), true)}
      </tfoot>
    </table>

    ${inv.note ? `<div style="margin-top:18px;font-size:13px;color:#444;background:#f9faf9;border-left:3px solid #A3E635;padding:10px 14px;">${esc(inv.note).replace(/\n/g, '<br>')}</div>` : ''}

    <div style="margin-top:24px;font-size:12px;color:#888;line-height:1.6;">
      ${
        isProforma
          ? 'This is a <strong>proforma invoice</strong> — not a tax invoice and not a demand for payment. It confirms the quoted price and is valid for 14 days. Reply to this email to proceed and we will issue payment instructions.'
          : 'Thank you for your purchase. This invoice confirms your order. Keep it for your records.'
      }
    </div>
    <div style="margin-top:14px;font-size:11px;color:#aaa;">${esc(c.name)}${c.email ? ' · ' + esc(c.email) : ''}</div>
  </div>`;

  const subject = `${isProforma ? 'Proforma' : 'Invoice'} ${inv.number} — ${c.name}`;
  return { subject, html };
}
