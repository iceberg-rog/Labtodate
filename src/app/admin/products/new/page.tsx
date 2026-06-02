import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AdminProductForm } from '@/components/admin/AdminProductForm';
import { adminCreateProduct, type AdminProductInputType } from '@/app/admin/actions';

export const dynamic = 'force-dynamic';

export default async function NewAdminProductPage() {
  await requireCapability('products:edit');

  const [categories, brands, companies] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);

  async function handle(input: AdminProductInputType) {
    'use server';
    const r = await adminCreateProduct(input);
    if (r.ok) redirect(`/admin/products?created=${r.slug}`);
    return r;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to products
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">New product</h1>
        <p className="text-muted-foreground mt-1">
          Add a product to your catalogue. Leave <strong>Shop</strong> empty to mark it as lab2date own
          inventory. Status defaults to <strong>Published</strong> — admins skip the seller review queue.
        </p>
      </div>
      <AdminProductForm
        categories={categories}
        brands={brands}
        companies={companies}
        onSubmit={handle}
        submitLabel="Create product"
      />
    </div>
  );
}
