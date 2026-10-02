import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { CategoryManager } from './CategoryManager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Categories' };

export default async function AdminCategoriesPage() {
  await requireCapability('categories:manage');
  const cats = await prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { products: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Categories</h1>
        <p className="text-muted-foreground mt-1">{cats.length} categories</p>
      </div>

      <CategoryManager
        categories={cats.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          description: c.description,
          productCount: c._count.products,
        }))}
      />
    </div>
  );
}
