import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ArrowRight, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';

export const metadata = { title: 'Order received' };
export const dynamic = 'force-dynamic';

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: { order?: string; dev?: string; pending?: string };
}) {
  if (!searchParams.order) notFound();

  const order = await prisma.order.findUnique({
    where: { orderNumber: searchParams.order },
    include: { items: true },
  });
  if (!order) notFound();

  const isPaid = order.status === 'PAID';

  return (
    <div className="container-px py-20 max-w-2xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/20 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        {isPaid ? 'Order placed.' : 'Order received.'}
      </h1>
      <p className="mt-4 text-muted-foreground text-lg">
        {isPaid
          ? "Your invoice is ready below — download it now. We'll also email it and coordinate delivery."
          : "Thanks — we have your order. We'll email you our bank-transfer details shortly. Once you've sent the wire, upload the receipt from your order page and our team will manually verify it before we dispatch."}
      </p>
      {!isPaid && (
        <p className="mt-3 inline-block rounded-full bg-amber-100 text-amber-900 text-xs px-3 py-1.5 font-semibold">
          Awaiting bank-transfer · manually verified · no charge taken
        </p>
      )}

      <div className="mt-10 rounded-2xl border border-border bg-card text-left p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground">Order #</p>
          <p className="font-mono font-bold">{order.orderNumber}</p>
        </div>
        <div className="space-y-3">
          {order.items.map((it) => (
            <div key={it.id} className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                <Package className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold">{it.titleSnapshot}</p>
                {it.brandSnapshot && <p className="text-xs text-muted-foreground">{it.brandSnapshot}</p>}
              </div>
              <p className="text-sm font-bold tabular-nums">{formatPrice(it.priceCentsSnapshot, order.currency)}</p>
            </div>
          ))}
        </div>
        <div className="border-t pt-4 flex items-center justify-between">
          <p className="text-sm font-semibold">Total</p>
          <p className="text-lg font-bold tabular-nums">{formatPrice(order.totalCents, order.currency)}</p>
        </div>
      </div>

      <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild size="lg" className="rounded-2xl font-semibold">
          <Link href={`/app/orders/${order.orderNumber}`}>
            View order &amp; status <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
          <Link href={`/app/orders/${order.orderNumber}/invoice`}>
            {isPaid ? 'Download invoice / receipt' : 'Download proforma'}
          </Link>
        </Button>
      </div>
      <p className="mt-4">
        <Link href="/marketplace" className="text-sm text-muted-foreground hover:text-foreground">
          Continue shopping
        </Link>
      </p>
    </div>
  );
}
