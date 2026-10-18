import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { CategoryManager } from './CategoryManager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Categories' };

export default async function AdminCategoriesPage() {
  await requireCapability('categories:manage');
  const [cats, live] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    }),
    prisma.product.groupBy({ by: ['categoryId'], where: LIVE_PRODUCT_WHERE, _count: { _all: true } }),
  ]);
  const liveBy = new Map(live.map((r) => [r.categoryId, r._count._all]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Categories</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">
          {cats.length} categories. The icon, picture and homepage order are used by the homepage instruments station when it picks
          categories automatically (Admin → Homepage can also choose them by hand); a category without live listings is never shown there.
        </p>
      </div>

      <CategoryManager
        categories={cats.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          description: c.description,
          icon: c.icon,
          imageUrl: c.imageUrl,
          parentId: c.parentId,
          sortOrder: c.sortOrder,
          showOnHome: c.showOnHome,
          homeOrder: c.homeOrder,
          seoTitle: c.seoTitle,
          seoDescription: c.seoDescription,
          productCount: c._count.products,
          liveCount: liveBy.get(c.id) ?? 0,
        }))}
      />
    </div>
  );
}
