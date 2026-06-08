import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { renderInvoiceHtml } from '@/lib/invoice';
import { PrintButton } from '@/components/util/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Invoice' };

export default async function InvoicePage({ params }: { params: { orderNumber: string } }) {
  const session = await requireSession({ redirectTo: `/app/orders/${params.orderNumber}/invoice` });
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { orderNumber: params.orderNumber },
    include: { items: true, buyer: { select: { name: true, email: true } } },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  const addrSrc = (order.billingAddress ?? order.shippingAddress) as Record<string, unknown> | null;
  let buyerAddress: string | null = null;
  let companyFromAddr: string | null = null;
  if (addrSrc && typeof addrSrc === 'object') {
    const ad = ((addrSrc.address as Record<string, unknown>) || addrSrc) as Record<string, unknown>;
    const cityLine = [ad.postal_code, ad.city].filter((x) => typeof x === 'string' && (x as string).trim()).join(' ');
    buyerAddress = [ad.line1, ad.line2, cityLine, ad.country]
      .filter((x) => typeof x === 'string' && (x as string).trim())
      .join('\n') || null;
    if (typeof addrSrc.company === 'string' && addrSrc.company.trim()) companyFromAddr = addrSrc.company.trim();
  }

  const paymentTermDays = 5;
  const dueDateISO = order.paidAt
    ? null
    : new Date((order.createdAt.getTime()) + paymentTermDays * 86_400_000).toISOString();
  const deliveryDateISO = order.paidAt ? order.paidAt.toISOString() : null;

  const { html } = renderInvoiceHtml({
    kind: 'INVOICE',
    number: order.orderNumber,
    dateISO: (order.paidAt ?? order.createdAt).toISOString(),
    currency: order.currency,
    buyer: { name: order.buyer.name, email: order.buyer.email, company: companyFromAddr },
    buyerAddress,
    paymentTermDays,
    dueDateISO,
    deliveryDateISO,
    lines: order.items.map((i) => ({
      title: i.titleSnapshot,
      qty: i.quantity,
      unitCents: i.priceCentsSnapshot,
    })),
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
  });

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      <div className="flex justify-end mb-6 print:hidden">
        <PrintButton />
      </div>
      <div className="rounded-2xl border border-border bg-white p-8">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
