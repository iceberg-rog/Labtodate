import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { createCategory, updateCategory, deleteCategory } from '../actions';

export const dynamic = 'force-dynamic';

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

      <form
        action={async (fd: FormData) => {
          'use server';
          await createCategory({
            name: String(fd.get('name') ?? ''),
            description: (fd.get('description') as string) || null,
          });
        }}
        className="rounded-2xl border border-border bg-card p-5 grid sm:grid-cols-[1fr_2fr_auto] gap-3 items-end"
      >
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
          <input name="name" required minLength={2} className="mt-1 w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Description</span>
          <input name="description" className="mt-1 w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <Button type="submit" className="rounded-full font-semibold h-10">Add category</Button>
      </form>

      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {cats.map((c) => (
          <li key={c.id} className="p-4 flex items-center gap-3 flex-wrap">
            <form
              action={async (fd: FormData) => {
                'use server';
                await updateCategory({
                  id: c.id,
                  name: String(fd.get('name') ?? ''),
                  description: (fd.get('description') as string) || null,
                });
              }}
              className="flex-1 min-w-[280px] grid sm:grid-cols-[1fr_1.5fr_auto] gap-2 items-center"
            >
              <input
                name="name"
                defaultValue={c.name}
                required
                minLength={2}
                className="h-9 px-3 rounded-lg border border-input bg-background text-sm font-medium"
              />
              <input
                name="description"
                defaultValue={c.description ?? ''}
                placeholder="Description"
                className="h-9 px-3 rounded-lg border border-input bg-background text-sm"
              />
              <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                Save
              </Button>
            </form>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">{c._count.products} products</span>
              <code className="text-xs text-muted-foreground">{c.slug}</code>
              <form
                action={async () => {
                  'use server';
                  await deleteCategory(c.id);
                }}
              >
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="rounded-full font-medium text-red-700 hover:bg-red-50"
                  disabled={c._count.products > 0}
                  title={c._count.products > 0 ? 'Move/remove its products first' : 'Delete category'}
                >
                  Delete
                </Button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
