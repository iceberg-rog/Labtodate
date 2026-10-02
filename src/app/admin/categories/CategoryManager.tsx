'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { createCategory, updateCategory, deleteCategory } from '../actions';

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  productCount: number;
}

/**
 * Add / rename / delete categories. The actions return {ok,message}; this
 * shows that message inline (it used to be a full-page 500 on any rejection).
 */
export function CategoryManager({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);

  function run(action: () => Promise<{ ok: boolean; message: string }>, onOk?: () => void) {
    setFlash(null);
    start(async () => {
      const r = await action();
      setFlash(r);
      if (r.ok) {
        onOk?.();
        router.refresh();
      }
    });
  }

  function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    run(
      () => createCategory({ name: String(fd.get('name') ?? ''), description: String(fd.get('description') ?? '') || null }),
      () => form.reset(),
    );
  }

  function save(e: React.FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    run(() => updateCategory({ id, name: String(fd.get('name') ?? ''), description: String(fd.get('description') ?? '') || null }));
  }

  function remove(c: CategoryRow) {
    if (!window.confirm(`Delete category “${c.name}”? This cannot be undone.`)) return;
    run(() => deleteCategory(c.id));
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={add}
        className="rounded-2xl border border-border bg-card p-5 grid sm:grid-cols-[1fr_2fr_auto] gap-3 items-end"
      >
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
          <input name="name" required minLength={2} maxLength={80} className="mt-1 w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Description</span>
          <input name="description" maxLength={200} className="mt-1 w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <Button type="submit" disabled={pending} className="rounded-full font-semibold h-10">Add category</Button>
      </form>

      {flash && (
        <div
          role={flash.ok ? 'status' : 'alert'}
          className={`rounded-xl border px-4 py-2 text-sm font-medium ${
            flash.ok
              ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300'
              : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
          }`}
        >
          {flash.message}
        </div>
      )}

      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {categories.map((c) => (
          <li key={c.id} className="p-4 flex items-center gap-3 flex-wrap">
            <form
              onSubmit={(e) => save(e, c.id)}
              className="flex-1 min-w-[280px] grid sm:grid-cols-[1fr_1.5fr_auto] gap-2 items-center"
            >
              <input
                name="name"
                defaultValue={c.name}
                required
                minLength={2}
                maxLength={80}
                className="h-9 px-3 rounded-lg border border-input bg-background text-sm font-medium"
              />
              <input
                name="description"
                defaultValue={c.description ?? ''}
                placeholder="Description"
                maxLength={200}
                className="h-9 px-3 rounded-lg border border-input bg-background text-sm"
              />
              <Button type="submit" variant="outline" size="sm" disabled={pending} className="rounded-full font-medium">
                Save
              </Button>
            </form>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">{c.productCount} products</span>
              <code className="text-xs text-muted-foreground">{c.slug}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(c)}
                className="rounded-full font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                disabled={pending || c.productCount > 0}
                title={c.productCount > 0 ? 'Move/remove its products first' : 'Delete category'}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
