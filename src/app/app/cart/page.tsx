import Link from 'next/link';
import Image from 'next/image';
import { ShoppingCart, Trash2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { setCartQty, removeFromCart } from '@/lib/cart/actions';

export const dynamic = 'force-dynamic';

export default async function CartPage({
  searchParams,
}: {
  searchParams: { added?: string };
}) {
  const session = await requireSession({ redirectTo: '/app/cart' });
  const items = await prisma.cartItem.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { slug: true, title: true, priceCents: true, currency: true, images: true, status: true, mode: true } } },
  });
  const valid = items.filter(
    (i) => i.product.status === 'PUBLISHED' && i.product.priceCents && i.product.mode !== 'QUOTE_ONLY',
  );
  const currency = valid[0]?.product.currency || 'EUR';
  const subtotal = valid.reduce((s, i) => s + (i.product.priceCents ?? 0) * i.quantity, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Cart</h1>
        <p className="text-muted-foreground mt-1">{valid.length} item{valid.length === 1 ? '' : 's'}</p>
      </div>

      {searchParams.added && valid.length > 0 && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 font-semibold">
          Added to cart ✓
        </div>
      )}

      {valid.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <ShoppingCart className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">Your cart is empty</p>
          <Button asChild className="rounded-full font-semibold mt-5">
            <Link href="/marketplace">Browse marketplace</Link>
          </Button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
          <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
            {valid.map((i) => (
              <li key={i.id} className="p-4 flex items-center gap-4 flex-wrap">
                <div className="relative h-16 w-20 rounded-lg overflow-hidden bg-white flex-shrink-0">
                  {i.product.images[0] && (
                    <Image src={i.product.images[0]} alt={i.product.title} fill sizes="80px" className="object-contain p-1.5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <Link href={`/marketplace/${i.product.slug}`} className="font-semibold hover:text-primary line-clamp-1">
                    {i.product.title}
                  </Link>
                  <p className="text-sm text-muted-foreground">{formatPrice(i.product.priceCents ?? 0, currency)} each</p>
                </div>
                <form action={async (fd: FormData) => { 'use server'; await setCartQty(i.id, parseInt(String(fd.get('q')), 10)); }} className="flex items-center gap-1">
                  <input name="q" type="number" min={1} max={99} defaultValue={i.quantity}
                    className="h-9 w-16 px-2 rounded-lg border border-input bg-background text-sm text-center" />
                  <Button type="submit" variant="outline" size="sm" className="rounded-full">Update</Button>
                </form>
                <p className="font-bold data w-24 text-right">{formatPrice((i.product.priceCents ?? 0) * i.quantity, currency)}</p>
                <form action={async () => { 'use server'; await removeFromCart(i.id); }}>
                  <Button type="submit" variant="ghost" size="icon" className="rounded-full text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </form>
              </li>
            ))}
          </ul>

          <div className="rounded-2xl border border-border bg-card p-6 space-y-4 lg:sticky lg:top-24">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-bold data">{formatPrice(subtotal, currency)}</span>
            </div>
            <p className="text-xs text-muted-foreground">Shipping &amp; tax calculated at checkout. Payment is by bank transfer, manually verified by our team.</p>
            <Button asChild size="lg" className="rounded-2xl font-semibold w-full">
              <Link href="/checkout/cart">
                Continue to shipping &amp; bank transfer <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="rounded-2xl font-semibold w-full">
              <Link href="/marketplace">Continue shopping</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
