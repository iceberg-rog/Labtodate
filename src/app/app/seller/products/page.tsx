import Link from 'next/link';
import { Plus, Edit2, Eye, EyeOff, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { deleteProduct, publishProduct } from './actions';
import { DeleteListingButton } from './DeleteListingButton';

export const dynamic = 'force-dynamic';

export default async function SellerProductsPage(
  props: {
    searchParams: Promise<{ created?: string; updated?: string; review?: string; deleted?: string; archived?: string; notice?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/products' });
  const isAdmin = (session.user as { role?: string }).role === 'ADMIN';

  const products = await prisma.product.findMany({
    where: { sellerId: session.user.id },
    orderBy: { updatedAt: 'desc' },
    include: { category: true, brand: true, _count: { select: { orderItems: true } } },
  });

  const banner =
    searchParams.created ? '✓ Listing created. Awaiting admin review before it goes live.'
    : searchParams.updated && searchParams.review ? '✓ Changes saved and sent for admin review. The listing is hidden from buyers until it is approved again.'
    : searchParams.updated ? '✓ Listing updated.'
    : searchParams.deleted ? '✓ Listing deleted.'
    : searchParams.archived ? '✓ This listing has past orders, so it was archived (hidden from buyers) instead of deleted.'
    : NOTICES[searchParams.notice ?? ''] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My listings</h1>
          <p className="text-muted-foreground mt-1">{products.length} products</p>
        </div>
        <Button asChild className="rounded-full font-semibold">
          <Link href="/app/seller/products/new">
            <Plus className="h-4 w-4" /> New listing
          </Link>
        </Button>
      </div>

      {banner && (
        <div role="status" className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300 px-4 py-3 text-sm">
          {banner}
        </div>
      )}

      {products.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <p className="text-lg font-semibold">No listings yet</p>
          <p className="text-sm text-muted-foreground mt-2">Create your first listing to get started.</p>
          <Button asChild className="rounded-full font-semibold mt-5">
            <Link href="/app/seller/products/new">
              <Plus className="h-4 w-4" /> Add a product
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {products.map((p) => (
            // Phones: details on top, the action buttons on their own wrapping
            // line below, so the title keeps its width and Delete stays
            // reachable. From md up it is one row, as before.
            <li key={p.id} className="p-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
              <div className="min-w-0 md:flex-1 flex items-center gap-4">
                <div className="flex-shrink-0 h-16 w-20 rounded-lg overflow-hidden bg-gradient-to-br from-[hsl(82_55%_94%)] to-[hsl(168_30%_94%)] p-2">
                  <InstrumentIllustration name={(p.illustration ?? 'balance') as IllustrationName} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    {p.brand?.name ?? '—'} · {p.category.name}
                  </p>
                  <Link href={`/marketplace/${p.slug}`} className="text-sm font-semibold hover:text-primary truncate block">
                    {p.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
                    <StatusBadge status={p.status} />
                    {/* Each "· value" pair wraps as a unit, so no line ends on a dot. */}
                    <span className="inline-flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">{p.condition.toLowerCase()}</span>
                    </span>
                    {p.priceCents !== null && (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs font-semibold tabular-nums">{formatPrice(p.priceCents, p.currency)}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 md:flex-nowrap md:flex-shrink-0">
                {/* Sellers can't publish directly (A3): a draft asks for review,
                    a queued listing just waits, a live one can be taken down. */}
                {!isAdmin && p.status === 'PENDING_REVIEW' ? (
                  <Button type="button" variant="ghost" size="sm" disabled className="rounded-full font-medium" title="An admin will review this listing before it goes live.">
                    <Clock className="h-3.5 w-3.5" /> In review
                  </Button>
                ) : (
                  <form action={publishProduct.bind(null, p.slug, p.status !== 'PUBLISHED')}>
                    <Button type="submit" variant="ghost" size="sm" className="rounded-full font-medium">
                      {p.status === 'PUBLISHED'
                        ? <><EyeOff className="h-3.5 w-3.5" /> Unpublish</>
                        : <><Eye className="h-3.5 w-3.5" /> {isAdmin ? 'Publish' : 'Request review'}</>}
                    </Button>
                  </form>
                )}
                <Button asChild variant="outline" size="sm" className="rounded-full font-medium">
                  <Link href={`/app/seller/products/${p.slug}/edit`}>
                    <Edit2 className="h-3.5 w-3.5" /> Edit
                  </Link>
                </Button>
                <form action={deleteProduct.bind(null, p.slug)}>
                  <DeleteListingButton title={p.title} hasOrders={p._count.orderItems > 0} />
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const NOTICES: Record<string, string> = {
  requested: '✓ Sent for review. An admin will approve the listing before it goes live.',
  'in-review': 'This listing is already waiting for admin review.',
  published: '✓ Listing published.',
  unpublished: '✓ Listing unpublished. It is hidden from buyers until it is published again.',
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'success' | 'warning' | 'secondary' | 'accent'; label: string }> = {
    PUBLISHED:      { variant: 'success', label: 'Published' },
    PENDING_REVIEW: { variant: 'warning', label: 'Awaiting review' },
    DRAFT:          { variant: 'secondary', label: 'Draft' },
    ARCHIVED:       { variant: 'secondary', label: 'Archived' },
  };
  const m = map[status] ?? { variant: 'secondary' as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
