'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Home, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CategoryIcon } from '@/components/home/CategoryIcon';
import { CATEGORY_ICONS } from '@/lib/home/category-icons';
import { createCategory, deleteCategory, updateCategory } from './actions';

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  imageUrl: string | null;
  parentId: string | null;
  sortOrder: number;
  showOnHome: boolean;
  homeOrder: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  productCount: number;
  liveCount: number;
}

const field = 'mt-1 w-full h-9 px-3 rounded-lg border border-input bg-background text-sm';
const label = 'block text-xs font-bold uppercase tracking-wider text-muted-foreground';

/** Every field of a category (add and edit share it). */
function CategoryFields({ c, all }: { c?: CategoryRow; all: CategoryRow[] }) {
  const [icon, setIcon] = useState(c?.icon ?? '');
  // a category cannot sit under itself or one of its own sub-categories
  const below = new Set<string>();
  if (c) {
    let grew = true;
    below.add(c.id);
    while (grew) {
      grew = false;
      for (const x of all) if (x.parentId && below.has(x.parentId) && !below.has(x.id)) { below.add(x.id); grew = true; }
    }
  }
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <label className="block">
        <span className={label}>Name</span>
        <input name="name" defaultValue={c?.name} required minLength={2} maxLength={80} className={field} />
      </label>
      {c ? (
        <div className="block">
          <span className={label}>Slug (link)</span>
          <code className="mt-1 flex items-center h-9 px-3 rounded-lg border border-border bg-foreground/[0.03] text-xs">/marketplace?category={c.slug}</code>
        </div>
      ) : (
        <label className="block">
          <span className={label}>Slug (link) — optional</span>
          <input name="slug" maxLength={80} placeholder="made from the name" pattern="[A-Za-z0-9-]*" title="Latin letters, digits and hyphens" className={`${field} font-mono`} />
        </label>
      )}
      <label className="block md:col-span-2">
        <span className={label}>Intro (shown on the category page)</span>
        <textarea name="description" defaultValue={c?.description ?? ''} maxLength={1000} rows={2} className="mt-1 w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
      </label>
      <label className="block">
        <span className={label}>Icon</span>
        <span className="mt-1 flex items-center gap-2">
          <span className="h-9 w-9 shrink-0 grid place-items-center rounded-lg border border-border"><CategoryIcon name={icon} className="h-4 w-4 text-primary" /></span>
          <select name="icon" value={icon} onChange={(e) => setIcon(e.target.value)} className={`${field} mt-0`}>
            <option value="">No icon</option>
            {CATEGORY_ICONS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
        </span>
      </label>
      <label className="block">
        <span className={label}>Parent</span>
        <select name="parentId" defaultValue={c?.parentId ?? ''} className={field}>
          <option value="">None (top level)</option>
          {all.filter((x) => !below.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="block md:col-span-2">
        <span className={label}>Picture (homepage card)</span>
        <span className="mt-1 grid sm:grid-cols-[1fr_auto] gap-2 items-center">
          <input name="imageUrl" defaultValue={c?.imageUrl ?? ''} placeholder="/media/… or product:<listing-slug> — empty = its best listing photo" className={`${field} mt-0 font-mono text-xs`} />
          <input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" className="text-xs" aria-label="Upload a picture" />
        </span>
        <span className="text-[11px] text-muted-foreground">An upload replaces the address. Only photos from your own media store are shown.</span>
      </label>
      <label className="block">
        <span className={label}>Sort order (lists)</span>
        <input name="sortOrder" type="number" min={0} max={9999} defaultValue={c?.sortOrder ?? ''} className={field} />
      </label>
      <div className="grid grid-cols-[auto_1fr] gap-3 items-end">
        <label className="flex items-center gap-2 h-9 text-sm font-medium">
          <input name="showOnHome" type="checkbox" defaultChecked={c?.showOnHome ?? true} className="h-4 w-4" /> Show on homepage
        </label>
        <label className="block">
          <span className={label}>Homepage order</span>
          <input name="homeOrder" type="number" min={0} max={9999} defaultValue={c?.homeOrder ?? ''} placeholder="after the ordered ones" className={field} />
        </label>
      </div>
      <label className="block">
        <span className={label}>Search title (max 70)</span>
        <input name="seoTitle" defaultValue={c?.seoTitle ?? ''} maxLength={70} placeholder="empty = made from the name" className={field} />
      </label>
      <label className="block">
        <span className={label}>Search description (max 170)</span>
        <input name="seoDescription" defaultValue={c?.seoDescription ?? ''} maxLength={170} placeholder="empty = made from the intro" className={field} />
      </label>
    </div>
  );
}

/**
 * Add, edit and delete categories: name, intro, icon (fixed set), picture,
 * parent, list order, homepage (shown + order), search title and description.
 * The actions return {ok,message}; it is shown inline.
 */
export function CategoryManager({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; message: string }>, onOk?: () => void) {
    setFlash(null);
    start(async () => {
      const r = await action().catch((e: unknown) => {
        // redirect() / notFound() are control flow, not failures — let Next handle them
        const digest = (e as { digest?: unknown })?.digest;
        if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw e;
        return { ok: false, message: 'Something went wrong on the server — nothing was changed. Try again.' };
      });
      setFlash(r);
      if (r.ok) {
        onOk?.();
        router.refresh();
      }
    });
  }

  const byId = new Map(categories.map((c) => [c.id, c]));
  const depth = (c: CategoryRow) => { let d = 0; for (let p = c.parentId; p && d < 6; p = byId.get(p)?.parentId ?? null) d++; return d; };
  // parents before their children, each level in list order
  const ordered: CategoryRow[] = [];
  const walk = (parent: string | null) => {
    for (const c of categories.filter((x) => (x.parentId ?? null) === parent && (parent === null || byId.has(parent)))) {
      ordered.push(c);
      walk(c.id);
    }
  };
  walk(null);
  for (const c of categories) if (!ordered.includes(c)) ordered.push(c);

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          run(() => createCategory(fd), () => form.reset());
        }}
        className="rounded-2xl border border-border bg-card p-5 space-y-4"
      >
        <h2 className="font-semibold">Add category</h2>
        <CategoryFields all={categories} />
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
        {ordered.map((c) => (
          <li key={c.id} className="p-4 space-y-3" data-category={c.slug}>
            <div className="flex items-center gap-3 flex-wrap" style={{ paddingLeft: `${depth(c) * 20}px` }}>
              <span className="h-8 w-8 shrink-0 grid place-items-center rounded-lg border border-border"><CategoryIcon name={c.icon} className="h-4 w-4 text-primary" /></span>
              <span className="flex-1 min-w-[12rem]">
                <b className="text-sm">{c.name}</b>
                <code className="ml-2 text-xs text-muted-foreground">{c.slug}</code>
              </span>
              {c.showOnHome && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title="Shown on the homepage while it picks categories automatically"><Home className="h-3 w-3" /> homepage{c.homeOrder != null ? ` #${c.homeOrder}` : ''}</span>}
              <span className="text-xs text-muted-foreground tabular-nums">{c.liveCount} live / {c.productCount} products</span>
              <Button type="button" variant="outline" size="sm" className="rounded-full font-medium" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                <Pencil className="h-3.5 w-3.5" /> {open === c.id ? 'Close' : 'Edit'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { if (window.confirm(`Delete category “${c.name}”? This cannot be undone.`)) run(() => deleteCategory(c.id)); }}
                className="rounded-full font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                disabled={pending || c.productCount > 0}
                title={c.productCount > 0 ? 'Move/remove its products first' : 'Delete category'}
              >
                Delete
              </Button>
            </div>
            {open === c.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  fd.set('id', c.id);
                  run(() => updateCategory(fd), () => setOpen(null));
                }}
                className="rounded-xl border border-border bg-foreground/[0.02] p-4 space-y-3"
              >
                <CategoryFields c={c} all={categories} />
                <Button type="submit" disabled={pending} className="rounded-full font-semibold">Save</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
