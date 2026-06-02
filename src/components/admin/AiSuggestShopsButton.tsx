'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, X, ExternalLink, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { aiSuggestShops } from '@/app/admin/actions';

interface Suggestion {
  name: string;
  url: string;
  country: string;
  rationale: string;
}

export function AiSuggestShopsButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [skipped, setSkipped] = useState<number>(0);
  const [skippedHosts, setSkippedHosts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setSuggestions(null); setAdded(null); setSkipped(0); setSkippedHosts([]); setError(null);
    start(async () => {
      const r = await aiSuggestShops();
      if (!r.ok) { setError(r.message ?? 'AI call failed.'); return; }
      setSuggestions(r.suggestions ?? []);
      setAdded(r.added ?? 0);
      setSkipped(r.skipped ?? 0);
      setSkippedHosts(r.skippedHosts ?? []);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="rounded-full font-semibold"
        onClick={() => { setOpen(true); setSuggestions(null); setAdded(null); setError(null); }}
      >
        <Sparkles className="h-4 w-4" /> Find more shops with AI
        <span className="ml-1 inline-flex items-center px-1.5 py-0 rounded-full bg-amber-100 text-amber-900 text-[9px] font-bold uppercase tracking-wider">Experimental</span>
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <button type="button" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close" />
          <div className="relative w-full max-w-3xl bg-card border border-border rounded-2xl shadow-xl m-4 max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-border flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-purple-600" /> AI shop discovery
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[9px] font-bold uppercase tracking-wider">Experimental</span>
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Claude proposes refurb-lab-equipment suppliers from its training memory. <strong>Most suggestions will NOT have a WooCommerce import endpoint</strong> — open each one and use the live source preview to verify before clicking import. For one-off products from arbitrary websites, prefer <a href="/admin/products/import-url" className="text-primary hover:underline font-semibold">Import from URL</a> instead.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-foreground/5">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5 overflow-auto space-y-4">
              {!suggestions && !pending && !error && (
                <div className="rounded-2xl border-2 border-dashed border-border bg-foreground/[0.02] p-8 text-center">
                  <Sparkles className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                  <p className="font-semibold">Ready to discover</p>
                  <p className="text-sm text-muted-foreground mt-1">Click the button below to ask the AI for fresh supplier candidates.</p>
                  <Button onClick={run} className="rounded-full font-semibold mt-4">
                    <Sparkles className="h-4 w-4" /> Run AI discovery
                  </Button>
                </div>
              )}

              {pending && (
                <div className="text-center py-12">
                  <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-3" />
                  <p className="text-sm font-semibold">Asking Claude to find new shops…</p>
                  <p className="text-xs text-muted-foreground mt-1">Usually takes 5-15 seconds.</p>
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm font-semibold flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {error}
                </div>
              )}

              {suggestions && (
                <>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm font-semibold flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <span>
                      AI returned <strong>{suggestions.length}</strong> proposal{suggestions.length === 1 ? '' : 's'}.
                      {added != null && <> Added <strong>{added}</strong> after live-fetch verification.</>}
                      {skipped > 0 && <> <strong>{skipped}</strong> skipped — domain didn’t resolve / refused our request / already known.</>}
                      {' '}Click a shop row in the list to preview before importing.
                    </span>
                  </div>
                  {skippedHosts.length > 0 && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-xs">
                      <p className="font-bold mb-1 inline-flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Skipped during pre-flight</p>
                      <ul className="list-disc ml-5 space-y-0.5">
                        {skippedHosts.map((h, i) => <li key={i}><code>{h}</code></li>)}
                      </ul>
                    </div>
                  )}
                  <ul className="space-y-2">
                    {suggestions.map((s, i) => (
                      <li key={i} className="rounded-xl border border-border bg-card p-3">
                        <div className="flex items-center gap-3 flex-wrap">
                          <p className="font-semibold">{s.name}</p>
                          {s.country && (
                            <span className="inline-flex px-2 py-0.5 rounded-full bg-foreground/10 text-foreground text-[10px] font-bold uppercase tracking-wider">{s.country}</span>
                          )}
                          <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline inline-flex items-center gap-1 ml-auto">
                            <ExternalLink className="h-3 w-3" /> {(() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return s.url; } })()}
                          </a>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{s.rationale}</p>
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-end pt-3">
                    <Button onClick={run} variant="outline" className="rounded-full" disabled={pending}>
                      <Sparkles className="h-3.5 w-3.5" /> Ask again (different set)
                    </Button>
                  </div>
                </>
              )}
            </div>

            <div className="p-4 border-t border-border flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(false)} className="rounded-full">Close</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
