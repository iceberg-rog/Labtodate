'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { localizeProductImagesBatch } from '@/app/admin/catalog-actions';

/**
 * Copies every product photo that is still on a supplier's server into our
 * media store, batch by batch, showing progress and every failure.
 */
export function SelfHostPhotosButton({ products, photos }: { products: number; photos: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: boolean; text: string; failed: { slug: string; url: string; error: string }[] } | null>(null);

  async function run() {
    setRunning(true);
    setDone(null);
    let cursor: string | null = null;
    let processed = 0;
    let downloaded = 0;
    let hosted = 0;
    const failed: { slug: string; url: string; error: string }[] = [];
    try {
      for (let i = 0; i < 1000; i++) {
        const r = await localizeProductImagesBatch(cursor, 20);
        processed += r.processed;
        downloaded += r.downloaded;
        hosted += r.hosted;
        failed.push(...r.failed);
        setProgress(`${processed} of ${products} product(s) done · ${hosted} photo(s) self-hosted (${downloaded} downloaded)${failed.length ? ` · ${failed.length} failed` : ''}`);
        cursor = r.nextCursor;
        if (!cursor) {
          setDone({
            ok: failed.length === 0,
            text: `Finished: ${hosted} photo(s) now served from our media store (${downloaded} downloaded, the rest were already stored). ${r.remaining} product(s) still have a photo that could not be copied${r.remaining ? ' (hidden from buyers; try again later)' : ''}.`,
            failed,
          });
          break;
        }
      }
    } catch {
      setDone({ ok: false, text: `Stopped after ${processed} product(s): the request failed (connection or server error). Run it again to continue — finished products are skipped.`, failed });
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  // Rendered on every visit so a finished run keeps its result on screen after
  // the list refreshes (the count is then 0); nothing to show otherwise.
  if (photos === 0 && !running && !done) return null;
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm space-y-2" data-testid="self-host-photos">
      {photos > 0 ? (
        <p>
          <strong>{`${photos} product photo(s)`}</strong>
          {` on ${products} listing(s) are still on a supplier’s server. Buyers do not see them (that would reveal the supplier and break when its site changes) — copy them into our own media store.`}
        </p>
      ) : (
        <p>Every product photo is served from our own media store.</p>
      )}
      {(photos > 0 || running) && (
        <Button type="button" size="sm" onClick={run} disabled={running} className="rounded-full font-semibold">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />} Self-host photos
        </Button>
      )}
      {progress && <p className="text-xs">{progress}</p>}
      {done && (
        <div role="status" className="text-xs space-y-1">
          <p className="font-semibold">{done.text}</p>
          {done.failed.slice(0, 10).map((f) => (
            <p key={f.url}>
              {f.slug}: {f.error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
