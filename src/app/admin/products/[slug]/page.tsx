import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { AdminProductForm } from '@/components/admin/AdminProductForm';
import { adminUpdateProduct, adminDeleteProduct, type AdminProductInputType } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { redirect } from 'next/navigation';
import type { IllustrationName } from '@/components/illustrations/instruments';
import { DeleteProductButton } from './DeleteProductButton';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('products:edit', 'Edit product', async () => {
    const { slug } = await props.params;
    const p = await prisma.product.findUnique({ where: { slug }, select: { title: true } });
    return p && `Edit: ${p.title}`;
  });
}

export default async function AdminProductEditPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  await requireCapability('products:edit');

  const product = await prisma.product.findUnique({ where: { slug: params.slug } });
  if (!product) notFound();

  const [categories, brands, companies, orderLines] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.orderItem.count({ where: { productId: product.id } }),
  ]);

  const initial: Partial<AdminProductInputType> = {
    title: product.title,
    summary: product.summary ?? null,
    description: product.description ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId ?? null,
    companyId: product.companyId ?? null,
    condition: product.condition,
    mode: product.mode,
    priceCents: product.priceCents ?? null,
    currency: product.currency,
    quantity: product.quantity,
    yearMade: product.yearMade ?? null,
    illustration: (product.illustration ?? 'balance') as IllustrationName,
    images: product.images,
    specs: (product.specs as Record<string, string> | null) ?? {},
    status: product.status,
  };

  const slug = product.slug;
  async function handleSave(input: AdminProductInputType) {
    'use server';
    return adminUpdateProduct(slug, input);
  }
  async function handleDelete() {
    'use server';
    const r = await adminDeleteProduct(slug);
    if (!r.ok) redirect('/admin/products');
    // Say what really happened: products with orders are archived, not deleted.
    redirect(r.outcome === 'archived' ? '/admin/products?archived=1' : '/admin/products?deleted=1');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <Link
            href="/admin/products"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to products
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Edit product</h1>
          <p className="text-muted-foreground mt-1 truncate max-w-xl">{product.title}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="rounded-full">
            <Link href={`/marketplace/${product.slug}`} target="_blank">
              <ExternalLink className="h-3.5 w-3.5" /> View live
            </Link>
          </Button>
          <form action={handleDelete}>
            <DeleteProductButton title={product.title} hasOrders={orderLines > 0} />
          </form>
        </div>
      </div>
      <AdminProductForm
        initial={initial}
        categories={categories}
        brands={brands}
        companies={companies}
        onSubmit={handleSave}
        submitLabel="Save changes"
      />
    </div>
  );
}
