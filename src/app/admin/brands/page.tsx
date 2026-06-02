import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { BrandManager } from '@/components/admin/BrandManager';

export const dynamic = 'force-dynamic';

export default async function AdminBrandsPage() {
  await requireCapability('products:edit');

  const brands = await prisma.brand.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      logoUrl: true,
      _count: { select: { products: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to products
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Brands</h1>
        <p className="text-muted-foreground mt-1">
          {brands.length} brand{brands.length === 1 ? '' : 's'} — used by sellers and admins when adding products.
        </p>
      </div>
      <BrandManager brands={brands.map((b) => ({ ...b, productCount: b._count.products }))} />
    </div>
  );
}
