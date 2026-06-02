'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Save, Loader2, X, Pencil, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createBrand, updateBrand, deleteBrand } from '@/app/admin/actions';

interface BrandRow {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  productCount: number;
}

export function BrandManager({ brands }: { brands: BrandRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newLogo, setNewLogo] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; logoUrl: string } | null>(null);
  const [uploading, setUploading] = useState<'new' | string | null>(null);
  const [q, setQ] = useState('');

  async function handleLogo(e: React.ChangeEvent<HTMLInputElement>, target: 'new' | string) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(target);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      if (target === 'new') setNewLogo(data.url);
      else if (editing && editing.id === target) setEditing({ ...editing, logoUrl: data.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
      e.target.value = '';
    }
  }

  function flash(text: string, ok = true) {
    if (ok) { setMsg(text); setError(null); }
    else { setError(text); setMsg(null); }
    setTimeout(() => { setMsg(null); setError(null); }, 3000);
  }

  function add() {
    setError(null); setMsg(null);
    if (newName.trim().length < 2) { setError('Brand name must be at least 2 characters.'); return; }
    start(async () => {
      const r = await createBrand({ name: newName.trim(), logoUrl: newLogo || null });
      if (r.ok) {
        flash(r.message);
        setNewName(''); setNewLogo('');
        router.refresh();
      } else flash(r.message, false);
    });
  }

  function save() {
    if (!editing) return;
    setError(null);
    if (editing.name.trim().length < 2) { setError('Brand name must be at least 2 characters.'); return; }
    start(async () => {
      const r = await updateBrand(editing.id, { name: editing.name.trim(), logoUrl: editing.logoUrl || null });
      if (r.ok) { flash(r.message); setEditing(null); router.refresh(); }
      else flash(r.message, false);
    });
  }

  function remove(b: BrandRow) {
    if (b.productCount > 0) { flash(`Cannot delete: ${b.productCount} product${b.productCount === 1 ? '' : 's'} use this brand.`, false); return; }
    if (!confirm(`Delete brand “${b.name}”?`)) return;
    start(async () => {
      const r = await deleteBrand(b.id);
      if (r.ok) { flash(r.message); router.refresh(); }
      else flash(r.message, false);
    });
  }

  const filtered = brands.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-5">
      {/* Add */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Plus className="h-5 w-5 text-primary" /> Add brand
        </h2>
        <div className="mt-4 grid sm:grid-cols-[1fr_auto_auto] gap-3 items-start">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Brand name (e.g. Sartorius)"
            className="h-10 px-3 rounded-lg border border-input bg-background text-sm"
          />
          <label className="inline-flex items-center gap-2 px-3 h-10 rounded-lg border border-input bg-background text-sm cursor-pointer hover:bg-foreground/[0.03]">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => handleLogo(e, 'new')}
              className="sr-only"
            />
            {uploading === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
            {newLogo ? 'Logo set' : 'Upload logo'}
          </label>
          <Button onClick={add} disabled={pending || !newName.trim()} className="rounded-full font-semibold">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add brand
          </Button>
        </div>
        {newLogo && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={newLogo} alt="logo" className="h-8 w-8 rounded object-contain bg-muted border border-border" />
            <button type="button" onClick={() => setNewLogo('')} className="text-red-600 hover:underline">Remove</button>
          </div>
        )}
      </section>

      {/* Flash */}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-2 text-sm font-medium">{msg}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-2 text-sm font-medium">{error}</div>}

      {/* List */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search brands…"
            className="h-9 px-3 rounded-lg border border-input bg-background text-sm flex-1 min-w-[200px]"
          />
          <span className="text-xs text-muted-foreground">{filtered.length} of {brands.length}</span>
        </div>
        <ul className="divide-y divide-border">
          {filtered.length === 0 && (
            <li className="p-8 text-center text-sm text-muted-foreground">No brands match.</li>
          )}
          {filtered.map((b) => (
            <li key={b.id} className="p-4 flex items-center gap-3 flex-wrap">
              {editing?.id === b.id ? (
                <>
                  <div className="h-10 w-10 rounded-lg bg-muted border border-border flex items-center justify-center overflow-hidden">
                    {editing.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={editing.logoUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    className="h-9 px-3 rounded-lg border border-input bg-background text-sm flex-1 min-w-[160px]"
                  />
                  <label className="inline-flex items-center gap-2 px-3 h-9 rounded-lg border border-input bg-background text-xs cursor-pointer hover:bg-foreground/[0.03]">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      onChange={(e) => handleLogo(e, b.id)}
                      className="sr-only"
                    />
                    {uploading === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                    Logo
                  </label>
                  <Button size="sm" onClick={save} disabled={pending} className="rounded-full">
                    <Save className="h-3.5 w-3.5" /> Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)} className="rounded-full">
                    <X className="h-3.5 w-3.5" /> Cancel
                  </Button>
                </>
              ) : (
                <>
                  <div className="h-10 w-10 rounded-lg bg-muted border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                    {b.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.logoUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-xs font-bold text-muted-foreground">{b.name.slice(0, 2).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{b.name}</p>
                    <p className="text-xs text-muted-foreground">slug: {b.slug} · {b.productCount} product{b.productCount === 1 ? '' : 's'}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditing({ id: b.id, name: b.name, logoUrl: b.logoUrl ?? '' })} className="rounded-full">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => remove(b)}
                    disabled={b.productCount > 0}
                    className="rounded-full text-red-700 border-red-200 hover:bg-red-50 disabled:opacity-40"
                    title={b.productCount > 0 ? 'In use — cannot delete' : 'Delete'}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
