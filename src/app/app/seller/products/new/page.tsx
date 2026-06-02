import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProductForm } from '@/components/seller/ProductForm';
import { createProduct } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/products/new' });

  const [categories, brands] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New listing</h1>
        <p className="text-muted-foreground mt-1">Tell buyers what you&apos;re selling. Submitted for admin review before going live.</p>
      </div>
      <ProductForm categories={categories} brands={brands} onSubmit={createProduct} submitLabel="Submit for review" />
    </div>
  );
}
