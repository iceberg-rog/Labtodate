'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Unlock, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { setProductFieldLock } from '@/app/admin/catalog-actions';

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  summary: 'Summary',
  description: 'Description',
  images: 'Photos',
  price: 'Price',
};

/**
 * Supplier-sync status of one imported product: where it comes from, what the
 * source last said, and which fields the sync may not change (locks).
 */
export function ProductSyncPanel({
  slug,
  shopName,
  shopSlug,
  syncPolicy,
  externalId,
  sourceUrl,
  sourceAvailability,
  lastSyncedAt,
  removedAtSourceAt,
  lockedFields,
  foreignPhotos,
}: {
  slug: string;
  shopName: string | null;
  shopSlug: string | null;
  syncPolicy: 'PRICE_STOCK_ONLY' | 'CONTENT_TOO' | null;
  externalId: string | null;
  sourceUrl: string | null;
  sourceAvailability: string | null;
  lastSyncedAt: string | null;
  removedAtSourceAt: string | null;
  lockedFields: string[];
  foreignPhotos: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(field: string, lock: boolean) {
    setMsg(null);
    start(async () => {
      const r = await setProductFieldLock(slug, field, lock);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  }

  const synced = syncPolicy === 'CONTENT_TOO' ? ['price', 'title', 'summary', 'description', 'images'] : ['price'];

  return (
    <section className="rounded-2xl border border-border bg-card p-6 space-y-3 max-w-4xl" data-testid="sync-panel">
      <h2 className="text-lg font-bold inline-flex items-center gap-2">
        <RefreshCw className="h-5 w-5 text-primary" /> Supplier sync
      </h2>
      {externalId ? (
        <>
          <p className="text-sm text-muted-foreground">
            Imported from <strong>{shopName}</strong> (source item #{externalId})
            {sourceUrl && (
              <>
                {' · '}
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                  open at the source <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            {shopSlug && (
              <>
                {' · '}
                <a href={`/admin/companies/${shopSlug}`} className="text-primary hover:underline">shop sync settings</a>
              </>
            )}
          </p>
          <p className="text-sm">
            Source says: <strong>{sourceAvailability ?? 'unknown'}</strong>
            {lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleString('en-GB')}` : ' · never synced with the new engine'}
            {removedAtSourceAt ? ` · removed at the source on ${new Date(removedAtSourceAt).toLocaleDateString('en-GB')}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Policy “{syncPolicy === 'CONTENT_TOO' ? 'price, stock and content' : 'price and stock only'}”: a sync may change{' '}
            {synced.map((f) => FIELD_LABEL[f]).join(', ')} and availability. Lock a field to keep your version; editing it here locks it automatically.
          </p>
          <ul className="flex flex-wrap gap-2">
            {Object.keys(FIELD_LABEL).map((f) => {
              const locked = lockedFields.includes(f);
              const policySyncs = synced.includes(f);
              return (
                <li key={f}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => toggle(f, !locked)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold ${
                      locked
                        ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'border-border hover:bg-foreground/[0.03]'
                    }`}
                    aria-pressed={locked}
                    data-lock-field={f}
                  >
                    {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                    {FIELD_LABEL[f]} {locked ? 'locked' : policySyncs ? 'synced' : 'yours (policy)'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {shopName ? `Listed under ${shopName}, but not linked to a source item yet (it is linked on the next sync if the source still has it).` : 'Own inventory — not synced from a supplier.'}
        </p>
      )}
      {foreignPhotos > 0 && (
        <p className="text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-3 py-2">
          {foreignPhotos} photo(s) are still on another server and are hidden from buyers until they are copied to our media store
          (Admin → Products → Self-host photos, or the next sync).
        </p>
      )}
      {msg && (
        <p role="status" className={`text-xs font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
