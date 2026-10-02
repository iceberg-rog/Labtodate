'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2, Save, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updateCompany } from '@/app/admin/actions';

export interface EditableShop {
  slug: string;
  name: string;
  country: string | null;
  website: string | null;
  importSourceUrl: string | null;
}

/** Edit a shop's name / country / website / import URL. */
export function ShopEditDialog({ shop, onClose }: { shop: EditableShop | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [website, setWebsite] = useState('');
  const [importUrl, setImportUrl] = useState('');

  useEffect(() => {
    if (!shop) return;
    setError(null);
    setName(shop.name);
    setCountry(shop.country ?? '');
    setWebsite(shop.website ?? '');
    setImportUrl(shop.importSourceUrl ?? '');
  }, [shop]);

  if (!shop) return null;

  function save() {
    if (!shop) return;
    setError(null);
    if (name.trim().length < 2) { setError('Shop name must be at least 2 characters.'); return; }
    for (const [label, v] of [['Public website', website], ['Import URL', importUrl]] as const) {
      if (v.trim() && !isWebUrl(v.trim())) {
        setError(`${label} must be a full web address starting with http:// or https://.`);
        return;
      }
    }
    start(async () => {
      const r = await updateCompany(shop.slug, {
        name: name.trim(),
        country: country.trim() || null,
        website: website.trim() || null,
        importSourceUrl: importUrl.trim() || null,
      });
      if (!r.ok) { setError(r.message); return; }
      onClose();
      router.refresh();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal aria-labelledby="shop-edit-title">
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close" />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-xl m-4">
        <div className="p-5 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="shop-edit-title" className="text-lg font-bold">Edit shop</h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">slug: {shop.slug} (kept so existing links keep working)</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-foreground/5" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Shop name (required)">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={input} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Country">
              <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={80} className={input} />
            </Field>
            <Field label="Public website">
              <input value={website} onChange={(e) => setWebsite(e.target.value)} className={input} placeholder="https://…" />
            </Field>
          </div>
          <Field label="Import URL (Woo Store API base)">
            <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} className={input} placeholder="https://shop.example.com" />
          </Field>
          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold flex items-start gap-2 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> {error}
            </p>
          )}
        </div>
        <div className="p-4 border-t border-border flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="rounded-full">Cancel</Button>
          <Button onClick={save} disabled={pending || !name.trim()} className="rounded-full font-semibold">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save shop
          </Button>
        </div>
      </div>
    </div>
  );
}

function isWebUrl(v: string): boolean {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

const input = 'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {children}
    </label>
  );
}
