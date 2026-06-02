import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formatPrice } from '@/lib/utils';
import { humaniseBuyer, smartDate, STATUS_LABEL } from '@/lib/orders/display';
import { InvoiceActions } from '@/components/admin/InvoiceActions';

export const dynamic = 'force-dynamic';

function fmtAddrLines(a: unknown): { name?: string; lines: string[] } | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown>) || o;
  const lines = [
    typeof ad.line1 === 'string' ? ad.line1 : null,
    typeof ad.line2 === 'string' ? ad.line2 : null,
    [
      typeof ad.postal_code === 'string' ? ad.postal_code : null,
      typeof ad.city === 'string' ? ad.city : null,
      typeof ad.state === 'string' ? ad.state : null,
    ].filter(Boolean).join(' '),
    typeof ad.country === 'string' ? ad.country : null,
    typeof o.phone === 'string' ? `Tel: ${o.phone}` : null,
    typeof o.email === 'string' ? `Email: ${o.email}` : null,
  ].filter((x): x is string => !!x && x.trim().length > 0);
  return { name: typeof o.name === 'string' ? o.name : undefined, lines };
}

export default async function InvoicePage({ params }: { params: { id: string } }) {
  await requireCapability('orders:view');
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: {
      buyer: { select: { name: true, email: true } },
      items: true,
    },
  });
  if (!order) notFound();

  const buyer = humaniseBuyer(order.buyer);
  const ship = fmtAddrLines(order.shippingAddress);
  const bill = fmtAddrLines(order.billingAddress) ?? ship;

  const site = process.env.SITE_NAME || 'lab2date';
  const company = {
    legal: process.env.COMPANY_LEGAL_NAME || site,
    address: process.env.COMPANY_ADDRESS || '',
    country: process.env.COMPANY_COUNTRY || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || process.env.SUPPORT_EMAIL || '',
    vat: process.env.COMPANY_VAT || '',
    logo: process.env.COMPANY_LOGO_URL || '',
  };

  const itemsSubtotal = order.items.reduce((s, i) => s + i.priceCentsSnapshot * i.quantity, 0);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <style dangerouslySetInnerHTML={{ __html: `
        @page { size: A4; margin: 18mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
        }
        body { background: #f4f4f0; }
        .invoice-sheet {
          background: white;
          color: #111;
          width: 210mm;
          min-height: 297mm;
          margin: 24px auto;
          padding: 18mm;
          box-shadow: 0 8px 40px rgba(0,0,0,0.08);
          font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
          font-size: 12px;
          line-height: 1.5;
        }
        .invoice-sheet h1, .invoice-sheet h2, .invoice-sheet h3 { color: #0E4F40; }
        .invoice-sheet table { width: 100%; border-collapse: collapse; }
        .invoice-sheet th, .invoice-sheet td { padding: 8px 6px; }
        .invoice-sheet thead th { font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: #666; border-bottom: 1px solid #ddd; text-align: left; }
        .invoice-sheet tbody td { border-bottom: 1px solid #eee; vertical-align: top; }
        .invoice-sheet tfoot td { padding-top: 12px; font-weight: bold; }
        .stamp {
          display: inline-block;
          padding: 4px 12px;
          border: 2px solid currentColor;
          border-radius: 8px;
          font-weight: 800;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          transform: rotate(-6deg);
        }
      ` }} />

      <div className="no-print sticky top-0 z-50 bg-foreground/[0.04] border-b border-border px-4 py-2.5">
        <InvoiceActions backHref={`/admin/orders/${order.id}`} />
      </div>

      <main className="invoice-sheet">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32 }}>
          <div>
            {company.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={company.logo} alt={company.legal} style={{ maxHeight: 48, marginBottom: 12 }} />
            ) : (
              <p style={{ fontSize: 22, fontWeight: 800, color: '#0E4F40', letterSpacing: '-0.02em' }}>{company.legal}</p>
            )}
            <p style={{ color: '#444', whiteSpace: 'pre-wrap' }}>{company.address}</p>
            {company.country && <p style={{ color: '#444' }}>{company.country}</p>}
            {company.phone && <p style={{ color: '#444' }}>Tel: {company.phone}</p>}
            {company.email && <p style={{ color: '#444' }}>Email: {company.email}</p>}
            {company.vat && <p style={{ color: '#444' }}>VAT: {company.vat}</p>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <h1 style={{ fontSize: 28, margin: 0, letterSpacing: '-0.02em' }}>INVOICE</h1>
            <p style={{ margin: '4px 0 12px', fontSize: 13, fontWeight: 700 }}>
              <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{order.orderNumber}</span>
            </p>
            <p style={{ color: '#666', fontSize: 11 }}>Issued {smartDate(order.createdAt)}</p>
            {order.paidAt && <p style={{ color: '#666', fontSize: 11 }}>Paid {smartDate(order.paidAt)}</p>}
            <p style={{ marginTop: 10 }}>
              <span
                className="stamp"
                style={{
                  color:
                    order.status === 'PAID' || order.status === 'DELIVERED'
                      ? '#0E4F40'
                      : order.status === 'REFUNDED'
                        ? '#b91c1c'
                        : '#a16207',
                }}
              >
                {STATUS_LABEL[order.status] ?? order.status}
              </span>
            </p>
          </div>
        </div>

        {/* Bill-to / Ship-to */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 32 }}>
          <div>
            <p style={{ fontSize: 9, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 6 }}>Bill to</p>
            <p style={{ fontWeight: 700 }}>{buyer.primary}</p>
            {!buyer.anonymised && buyer.secondary && <p style={{ color: '#555' }}>{buyer.secondary}</p>}
            {bill && (
              <>
                {bill.name && bill.name !== buyer.primary && <p>{bill.name}</p>}
                {bill.lines.map((l, i) => <p key={i} style={{ color: '#555' }}>{l}</p>)}
              </>
            )}
          </div>
          <div>
            <p style={{ fontSize: 9, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 6 }}>Ship to</p>
            {ship ? (
              <>
                {ship.name && <p style={{ fontWeight: 700 }}>{ship.name}</p>}
                {ship.lines.map((l, i) => <p key={i} style={{ color: '#555' }}>{l}</p>)}
              </>
            ) : (
              <p style={{ color: '#888', fontStyle: 'italic' }}>No shipping address.</p>
            )}
            {order.trackingCarrier && (
              <p style={{ color: '#555', marginTop: 6 }}>
                Carrier: <strong>{order.trackingCarrier}</strong>
                {order.trackingNumber && <> · Tracking: <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{order.trackingNumber}</span></>}
              </p>
            )}
          </div>
        </div>

        {/* Items */}
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style={{ width: 60, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 100, textAlign: 'right' }}>Unit price</th>
              <th style={{ width: 110, textAlign: 'right' }}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((it) => (
              <tr key={it.id}>
                <td>
                  <strong>{it.titleSnapshot}</strong>
                  {it.brandSnapshot && <div style={{ color: '#777', fontSize: 11 }}>{it.brandSnapshot}</div>}
                </td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">{it.quantity}</td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">{formatPrice(it.priceCentsSnapshot, order.currency)}</td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">{formatPrice(it.priceCentsSnapshot * it.quantity, order.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ textAlign: 'right', color: '#666', fontWeight: 400 }}>Items subtotal</td>
              <td style={{ textAlign: 'right' }} className="tabular-nums">{formatPrice(itemsSubtotal, order.currency)}</td>
            </tr>
            {order.shippingCents > 0 && (
              <tr>
                <td colSpan={3} style={{ textAlign: 'right', color: '#666', fontWeight: 400 }}>Shipping</td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">{formatPrice(order.shippingCents, order.currency)}</td>
              </tr>
            )}
            {order.taxCents > 0 && (
              <tr>
                <td colSpan={3} style={{ textAlign: 'right', color: '#666', fontWeight: 400 }}>Tax</td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">{formatPrice(order.taxCents, order.currency)}</td>
              </tr>
            )}
            <tr>
              <td colSpan={3} style={{ textAlign: 'right', fontSize: 15 }}>TOTAL</td>
              <td style={{ textAlign: 'right', fontSize: 15 }} className="tabular-nums">{formatPrice(order.totalCents, order.currency)}</td>
            </tr>
          </tfoot>
        </table>

        {/* Payment info */}
        <div style={{ marginTop: 32, padding: 14, background: '#f5f5f0', borderRadius: 8, fontSize: 11, color: '#444' }}>
          <p style={{ fontWeight: 700, marginBottom: 4 }}>Payment</p>
          <p>
            Method:{' '}
            {/* BUG-014 fix: manual bank-transfer orders populate
                paymentMethodManual, not the Stripe paymentMethodBrand.
                Prefer the Stripe card brand when present, otherwise fall
                back to the manual method (e.g. BANK TRANSFER) so verified
                manual-paid orders no longer render "not yet captured"/"—". */}
            {order.paymentMethodBrand ? (
              <strong>
                {order.paymentMethodBrand.toUpperCase().replace(/_/g, ' ')}
                {order.paymentMethodLast4 ? ` •••• ${order.paymentMethodLast4}` : ''}
                {order.paymentMethodWallet ? ` · ${order.paymentMethodWallet.replace(/_/g, ' ')}` : ''}
              </strong>
            ) : order.paymentMethodManual ? (
              <strong>{order.paymentMethodManual.toUpperCase().replace(/_/g, ' ')}</strong>
            ) : (
              <em style={{ color: '#888' }}>not yet captured</em>
            )}
            {order.paidAt && <> · Paid on <strong>{smartDate(order.paidAt)}</strong></>}
          </p>
          {order.stripePaymentIntentId && (
            <p style={{ marginTop: 4 }}>
              Reference: <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{order.stripePaymentIntentId}</span>
            </p>
          )}
        </div>

        {order.adminNotes && (
          <div style={{ marginTop: 16, padding: 14, background: '#fffae8', border: '1px solid #f0e0a0', borderRadius: 8, fontSize: 11, color: '#5a4400' }}>
            <p style={{ fontWeight: 700, marginBottom: 4 }}>Internal note (not shown to buyer print)</p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{order.adminNotes}</p>
          </div>
        )}

        {/* Footer */}
        <p style={{ marginTop: 40, fontSize: 10, color: '#888', textAlign: 'center' }}>
          Thank you for your business. {company.legal}
          {company.vat && ` · VAT ${company.vat}`}
        </p>
      </main>
    </>
  );
}
