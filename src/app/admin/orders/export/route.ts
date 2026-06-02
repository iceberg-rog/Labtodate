import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { humaniseBuyer } from '@/lib/orders/display';

export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Streams a UTF-8 CSV of orders (Excel-friendly with BOM) for accounting /
 * external book-keeping. Honours ?range= (7d|30d|90d|all) — defaults to all.
 */
export async function GET(req: Request) {
  await requireCapability('orders:view');
  const url = new URL(req.url);
  const range = url.searchParams.get('range');
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;

  const where = days ? { createdAt: { gte: new Date(Date.now() - days * 864e5) } } : {};

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      buyer: { select: { name: true, email: true } },
      items: { select: { titleSnapshot: true, quantity: true, priceCentsSnapshot: true } },
    },
  });

  const header = [
    'order_number',
    'created_at_iso',
    'status',
    'buyer',
    'buyer_email',
    'items',
    'subtotal',
    'shipping',
    'tax',
    'total',
    'currency',
    'carrier',
    'tracking_number',
    'shipped_at_iso',
    'delivered_at_iso',
    'paid_at_iso',
    'stripe_payment_intent',
  ];

  const rows = orders.map((o) => {
    const b = humaniseBuyer(o.buyer);
    const items = o.items
      .map((i) => `${i.quantity}× ${i.titleSnapshot} (${(i.priceCentsSnapshot / 100).toFixed(2)})`)
      .join(' | ');
    return [
      o.orderNumber,
      o.createdAt.toISOString(),
      o.status,
      b.primary,
      b.anonymised ? '' : (o.buyer.email ?? ''),
      items,
      (o.subtotalCents / 100).toFixed(2),
      (o.shippingCents / 100).toFixed(2),
      (o.taxCents / 100).toFixed(2),
      (o.totalCents / 100).toFixed(2),
      o.currency,
      o.trackingCarrier ?? '',
      o.trackingNumber ?? '',
      o.shippedAt?.toISOString() ?? '',
      o.deliveredAt?.toISOString() ?? '',
      o.paidAt?.toISOString() ?? '',
      o.stripePaymentIntentId ?? '',
    ].map(csvCell).join(',');
  });

  const csv = '﻿' + [header.join(','), ...rows].join('\n');
  const filename = `lab2date-orders${range ? `-${range}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
