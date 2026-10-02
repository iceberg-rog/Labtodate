import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProductForm } from '@/components/seller/ProductForm';
import { updateProduct } from '../../actions';
import type { IllustrationName } from '@/components/illustrations/instruments';
import type { ProductInputType } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function EditProductPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: `/app/seller/products/${params.slug}/edit` });

  const product = await prisma.product.findUnique({ where: { slug: params.slug } });
  if (!product) notFound();

  const role = (session.user as { role?: string }).role;
  if (product.sellerId !== session.user.id && role !== 'ADMIN') notFound();

  const [categories, brands] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }),
  ]);

  const initial: Partial<ProductInputType> & { slug: string } = {
    slug: product.slug,
    title: product.title,
    summary: product.summary ?? null,
    description: product.description ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId ?? null,
    condition: product.condition,
    mode: product.mode,
    priceCents: product.priceCents ?? null,
    currency: product.currency,
    yearMade: product.yearMade ?? null,
    illustration: (product.illustration ?? 'balance') as IllustrationName,
    images: product.images,
    specs: (product.specs as Record<string, string> | null) ?? {},
  };

  const slug = product.slug;
  async function handleSubmit(input: ProductInputType) {
    'use server';
    return updateProduct(slug, input);
  }
  // Sellers' edits to a live listing go back to admin review (INVARIANTS A3).
  const reReview = product.status === 'PUBLISHED' && role !== 'ADMIN';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Edit listing</h1>
        <p className="text-muted-foreground mt-1 truncate">{product.title}</p>
      </div>
      {reReview && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm max-w-3xl">
          This listing is live. If you change it, it goes back to admin review and is hidden from buyers until an admin approves it again.
        </div>
      )}
      <ProductForm initial={initial} categories={categories} brands={brands} onSubmit={handleSubmit} submitLabel="Save changes" />
    </div>
  );
}
