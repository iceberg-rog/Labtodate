import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { escapeHtml as esc } from '@/lib/email-html';
import { getCompany } from '@/lib/invoice';
import { companyLogoDataUri } from '@/lib/documents/logo';
import { fmtDocDate } from '@/lib/documents/render';
import { partyFromAddress } from '@/lib/documents/snapshot';
import { htmlToPdf } from '@/lib/documents/pdf';
import { fillTemplate } from './rules';
import { packingSlipNote, packingSlipTitle, returnWindowDays } from './policy';

/**
 * Packing slip / delivery note for one shipment (B12). NOT a fiscal document:
 * no number series, no prices, no VAT — rendered on demand from the shipment
 * record with the documents' PDF engine (lib/documents/pdf.ts) and the
 * company identity from Settings. Every person-typed value is escaped and
 * bidi-isolated (dir="auto").
 */

const u = (v: string | null | undefined) => (v ? `<div dir="auto">${esc(v)}</div>` : '');

const CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; font-family: Inter, "Segoe UI", Arial, "Noto Sans", "Noto Sans Arabic", Tahoma, sans-serif; font-size: 10pt; line-height: 1.4; }
  [dir="auto"] { unicode-bidi: plaintext; text-align: start; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0E4F40; padding-bottom: 12px; gap: 24px; }
  .brand img { max-height: 56px; max-width: 220px; }
  .brand .name { font-size: 18pt; font-weight: 800; color: #0E4F40; }
  h1 { margin: 0; font-size: 18pt; color: #0E4F40; text-transform: uppercase; text-align: right; }
  .no { font-family: Consolas, "DejaVu Sans Mono", monospace; font-weight: 700; text-align: right; margin-top: 2px; }
  .muted { color: #6b7280; }
  .grid { display: flex; gap: 18px; margin-top: 14px; }
  .box { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; overflow-wrap: anywhere; }
  .box h3 { margin: 0 0 4px; font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { background: #0E4F40; color: #fff; text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; padding: 7px 8px; }
  th.q, td.q { text-align: right; width: 70px; }
  th.c, td.c { width: 90px; text-align: center; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .note { margin-top: 16px; padding: 8px 12px; border-left: 3px solid #A3E635; background: #f9fafb; white-space: pre-wrap; }
  .sign { margin-top: 28px; display: flex; gap: 24px; }
  .sign div { flex: 1; border-top: 1px solid #9ca3af; padding-top: 4px; font-size: 8.5pt; color: #6b7280; }
`;

export async function packingSlipHtml(shipmentId: string): Promise<{ html: string; filename: string } | null> {
  await ensureSettingsLoaded();
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: { select: { titleSnapshot: true, brandSnapshot: true, conditionSnapshot: true } } } },
      order: { select: { orderNumber: true, poNumber: true, shippingAddress: true, billingAddress: true, buyer: { select: { name: true } }, items: { select: { quantity: true, lineType: true } }, shipments: { select: { items: { select: { qty: true } } } } } },
    },
  });
  if (!s) return null;
  const c = getCompany();
  const logo = await companyLogoDataUri(c.logoPath);
  const shipTo = partyFromAddress(s.order.shippingAddress, s.order.buyer.name);
  // Full country name for the carrier (the address JSON keeps the ISO code).
  if (shipTo?.country) {
    const cp = await prisma.countryPolicy.findUnique({ where: { country: shipTo.country }, select: { name: true } });
    if (cp?.name) shipTo.lines = shipTo.lines.map((l) => (l === shipTo.country ? cp.name : l));
  }
  const ordered = s.order.items.filter((i) => i.lineType === 'GOODS' || !i.lineType).reduce((a, i) => a + i.quantity, 0);
  const shippedSoFar = s.order.shipments.reduce((a, x) => a + x.items.reduce((b, i) => b + i.qty, 0), 0);
  const shipmentLabel = shippedSoFar < ordered ? `${s.seq} — partial delivery, more to follow` : `${s.seq} of ${s.order.shipments.length}`;
  const bill = s.order.billingAddress && typeof s.order.billingAddress === 'object' ? (s.order.billingAddress as Record<string, unknown>) : null;
  const po = (typeof bill?.poNumber === 'string' && bill.poNumber) || s.order.poNumber || '';
  const ship = s.order.shippingAddress && typeof s.order.shippingAddress === 'object' ? (s.order.shippingAddress as Record<string, unknown>) : {};
  const number = `PS-${s.order.orderNumber.replace(/^L2D-/i, '')}-${s.seq}`;
  const title = packingSlipTitle();
  const note = fillTemplate(packingSlipNote(), { ORDER: s.order.orderNumber, DAYS: returnWindowDays() });
  const meta: Array<[string, string]> = [
    ['Order no.', s.order.orderNumber],
    ...(po ? [['Your PO no.', po] as [string, string]] : []),
    ['Shipment', shipmentLabel],
    ['Ship date', s.shippedAt ? fmtDocDate(s.shippedAt) : '—'],
    ['Carrier', s.carrier ?? '—'],
    ...(s.trackingNumber ? [['Tracking no.', s.trackingNumber] as [string, string]] : []),
    ['Parcels', String(s.parcels)],
    ...(s.grossKg ? [['Gross weight', `${s.grossKg} kg`] as [string, string]] : []),
  ];
  const rows = s.items.map((i) => `<tr>
      <td>${u(i.orderItem.titleSnapshot)}<div class="muted">${esc([i.orderItem.brandSnapshot, i.orderItem.conditionSnapshot].filter(Boolean).join(' · '))}</div>${i.serial ? `<div class="muted">Serial ${esc(i.serial)}</div>` : ''}</td>
      <td class="q">${i.qty}</td>
      <td class="c">☐</td>
    </tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} ${esc(number)}</title><style>${CSS}</style></head><body>
  <header class="top">
    <div class="brand">${logo ? `<img src="${logo}" alt="${esc(c.name)}">` : `<div class="name" dir="auto">${esc(c.name)}</div>`}
      <div class="muted" style="margin-top:6px;font-size:9pt;">${logo ? `<strong dir="auto">${esc(c.name)}</strong><br>` : ''}${c.addrLines.map((l) => esc(l)).join('<br>')}${c.country ? `<br>${esc(c.country)}` : ''}${c.phone ? `<br>${esc(c.phone)}` : ''}</div>
    </div>
    <div><h1>${esc(title)}</h1><div class="no">${esc(number)}</div></div>
  </header>
  <section class="grid">
    <div class="box"><h3>Deliver to</h3>${shipTo ? `${shipTo.company ? u(shipTo.company) : ''}${u(shipTo.name)}${shipTo.lines.map((l) => u(l)).join('')}${typeof ship.phone === 'string' && ship.phone ? `<div dir="ltr">Tel. ${esc(ship.phone)}</div>` : ''}` : '<p class="muted">No delivery address.</p>'}</div>
    <div class="box"><h3>Shipment</h3><table style="margin:0">${meta.map(([k, v]) => `<tr><td class="muted" style="border:0;padding:1px 10px 1px 0">${esc(k)}</td><td style="border:0;padding:1px 0;font-weight:700" dir="auto">${esc(v)}</td></tr>`).join('')}</table></div>
  </section>
  <table>
    <thead><tr><th>Item</th><th class="q">Qty</th><th class="c">Checked</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${note ? `<div class="note" dir="auto">${esc(note)}</div>` : ''}
  <div class="sign"><div>Packed by / date</div><div>Received by (name, signature, date)</div></div>
  </body></html>`;
  return { html, filename: `${number}.pdf` };
}

export async function packingSlipPdf(shipmentId: string): Promise<{ bytes: Buffer; filename: string } | null> {
  const doc = await packingSlipHtml(shipmentId);
  if (!doc) return null;
  const bytes = await htmlToPdf(doc.html, { footerText: doc.filename.replace(/\.pdf$/, '') });
  return { bytes, filename: doc.filename };
}
