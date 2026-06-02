import Link from 'next/link';
import { Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProductCard } from '@/components/marketplace/ProductCard';
import type { IllustrationName } from '@/components/illustrations/instruments';

export const dynamic = 'force-dynamic';

export default async function WishlistPage() {
  const session = await requireSession({ redirectTo: '/app/wishlist' });

  const items = await prisma.wishlistItem.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      product: {
        select: {
          slug: true,
          title: true,
          illustration: true,
          images: true,
          condition: true,
          mode: true,
          priceCents: true,
          currency: true,
          yearMade: true,
          brand: { select: { name: true } },
          company: { select: { name: true } },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Wishlist</h1>
        <p className="text-muted-foreground mt-1">{items.length} saved items</p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Heart className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No saved items yet</p>
          <p className="text-sm text-muted-foreground mt-2">Tap the heart icon on any product to save it.</p>
          <Button asChild className="rounded-full font-semibold mt-5">
            <Link href="/marketplace">Browse marketplace</Link>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {items.map((w) => (
            <ProductCard
              key={w.id}
              p={{
                slug: w.product.slug,
                title: w.product.title,
                brand: w.product.brand?.name ?? '—',
                supplier: 'lab2date Verified Supplier',
                illustration: (w.product.illustration ?? 'balance') as IllustrationName,
                imageUrl: w.product.images?.[0] ?? null,
                condition: w.product.condition,
                mode: w.product.mode,
                priceCents: w.product.priceCents,
                currency: w.product.currency,
                yearMade: w.product.yearMade,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
