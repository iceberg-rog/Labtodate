'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  X, Loader2, RefreshCw, ExternalLink, CheckCircle2, XCircle, AlertTriangle,
  ShieldCheck, Database, Cloud, Sparkles, Eye, Package, Trash2, BadgeCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  previewShopFromDb,
  previewShopLive,
  aiAnalyzeShop,
  importShopProducts,
  blockSupplier,
  type PreviewProductCard,
} from '@/app/admin/actions';
import { ShopBrowser } from '@/components/admin/ShopBrowser';

type Tab = 'current' | 'source' | 'ai' | 'browser';

interface Props {
  open: boolean;
  shop: {
    slug: string;
    name: string;
    importSourceUrl: string | null;
    productCount: number;
    isVerified: boolean;
    suggestedByAi: boolean;
    aiRiskScore: number | null;
    aiRiskNotes: string | null;
    aiAnalyzedAt: string | null;
    lastImportedAt: string | null;
  } | null;
  onClose: () => void;
}

function fmtPrice(cents: number | null, currency: string): string {
  if (cents == null) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

export function ShopPreviewDialog({ open, shop, onClose }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('current');
  const [dbItems, setDbItems] = useState<PreviewProductCard[]>([]);
  const [dbTotal, setDbTotal] = useState(0);
  const [dbPage, setDbPage] = useState(1);
  const [liveItems, setLiveItems] = useState<PreviewProductCard[]>([]);
  const [liveTotal, setLiveTotal] = useState(0);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ score: number; verdict: string; notes: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewProduct, setPreviewProduct] = useState<PreviewProductCard | null>(null);
  const [importing, startImport] = useTransition();
  const [importMsg, setImportMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const loadDb = useCallback(async (pg: number) => {
    if (!shop) return;
    const r = await previewShopFromDb(shop.slug, pg, 24);
    if (r.ok) {
      setDbItems(r.items);
      setDbTotal(r.total);
      setDbPage(pg);
    }
  }, [shop]);

  const loadLive = useCallback(async () => {
    if (!shop?.importSourceUrl) return;
    setLiveLoading(true); setLiveError(null);
    const r = await previewShopLive(shop.importSourceUrl, 1, 24);
    setLiveLoading(false);
    if (!r.ok) { setLiveError(r.message ?? 'Live preview failed.'); return; }
    setLiveItems(r.items);
    setLiveTotal(r.total);
    // default: select everything not-already-imported
    setSelected(new Set(r.items.filter((p) => !p.alreadyImported).map((p) => p.sourceSlug ?? p.slug)));
  }, [shop]);

  const runAi = useCallback(async () => {
    if (!shop?.importSourceUrl) return;
    setAiLoading(true); setAiError(null);
    const r = await aiAnalyzeShop(shop.importSourceUrl, shop.slug);
    setAiLoading(false);
    if (!r.ok) { setAiError(r.message ?? 'AI analysis failed.'); return; }
    setAiResult(r.result ?? null);
    router.refresh();
  }, [shop, router]);

  useEffect(() => {
    if (!open || !shop) return;
    // Default tab: imported products if any exist, otherwise jump straight to
    // the in-app browser when the shop has an import URL — that's where the
    // operator can actually decide what to add.
    setTab(shop.productCount > 0 ? 'current' : shop.importSourceUrl ? 'browser' : 'ai');
    setDbItems([]); setDbTotal(0); setDbPage(1);
    setLiveItems([]); setLiveTotal(0); setLiveError(null);
    const cachedAi = shop.aiRiskScore != null && shop.aiRiskNotes
      ? { score: shop.aiRiskScore, verdict: shop.aiRiskScore >= 70 ? 'safe' : shop.aiRiskScore >= 40 ? 'caution' : 'risky', notes: shop.aiRiskNotes }
      : null;
    setAiResult(cachedAi);
    setAiError(null);
    setSelected(new Set());
    setImportMsg(null);
    if (shop.productCount > 0) void loadDb(1);
    // Auto-fetch live preview for any shop with an import URL — saves a click
    // and surfaces broken / non-Woo sources immediately. Suggested shops in
    // particular need this so the drawer is useful on open.
    if (shop.importSourceUrl) void loadLive();
    // Auto-run AI risk analysis for AI-suggested shops if there's no cached
    // verdict yet, OR if the cached "notes" still hold the suggestion
    // rationale (no real risk score yet — aiRiskScore is null).
    if (shop.importSourceUrl && shop.aiRiskScore == null) void runAi();
  }, [open, shop, loadDb, loadLive, runAi]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    if (open) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open || !shop) return null;

  const dbTotalPages = Math.max(1, Math.ceil(dbTotal / 24));
  const liveDeltaImported = liveItems.filter((p) => p.alreadyImported).length;
  const liveDeltaNew = liveItems.length - liveDeltaImported;

  function toggleSelected(s: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }

  function selectAllNew() {
    setSelected(new Set(liveItems.filter((p) => !p.alreadyImported).map((p) => p.sourceSlug ?? p.slug)));
  }
  function selectNone() { setSelected(new Set()); }

  function runImportSelected() {
    if (!shop) return;
    setImportMsg(null);
    if (selected.size === 0) { setImportMsg({ ok: false, message: 'No products selected.' }); return; }
    if (!confirm(`Import ${selected.size} product${selected.size === 1 ? '' : 's'} into the catalogue?`)) return;
    const s = shop;
    startImport(async () => {
      const r = await importShopProducts(s.slug, Array.from(selected));
      setImportMsg(r);
      if (r.ok) { router.refresh(); void loadDb(1); }
    });
  }

  function runImportAll() {
    if (!shop) return;
    setImportMsg(null);
    if (!confirm(`Import ALL ${liveTotal} products from ${shop.name}? (Existing slugs are upserted.)`)) return;
    const s = shop;
    startImport(async () => {
      const r = await importShopProducts(s.slug, null);
      setImportMsg(r);
      if (r.ok) { router.refresh(); void loadDb(1); }
    });
  }

  function dropShop() {
    if (!shop) return;
    if (!confirm(`Block “${shop.name}” permanently?\nIt will be removed AND added to the AI-suggest blocklist — future AI discovery runs will never propose this hostname again.`)) return;
    const s = shop;
    startImport(async () => {
      const r = await blockSupplier(s.slug, 'rejected via shop drawer');
      setImportMsg(r);
      if (r.ok) { onClose(); router.refresh(); }
    });
  }

  const verdict = aiResult?.verdict ?? null;
  const verdictTone =
    verdict === 'safe' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' :
    verdict === 'caution' ? 'border-amber-200 bg-amber-50 text-amber-900' :
    verdict === 'risky' ? 'border-red-200 bg-red-50 text-red-900' :
    'border-border bg-card text-muted-foreground';

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal>
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close" />
      <div className="relative ml-auto h-full w-full max-w-5xl bg-card border-l border-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="border-b border-border p-5 flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold flex-shrink-0">
            {shop.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold truncate">{shop.name}</h2>
              {shop.isVerified && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider">
                  <BadgeCheck className="h-3 w-3" /> Verified
                </span>
              )}
              {shop.suggestedByAi && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-900 text-[10px] font-bold uppercase tracking-wider">
                  <Sparkles className="h-3 w-3" /> AI suggested
                </span>
              )}
              {shop.lastImportedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-900 text-[10px] font-bold uppercase tracking-wider">
                  ✓ Imported
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              {shop.importSourceUrl && (
                <a href={shop.importSourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  <ExternalLink className="h-3 w-3" /> {new URL(shop.importSourceUrl).hostname.replace(/^www\./, '')}
                </a>
              )}
              <span><Package className="h-3 w-3 inline mr-0.5" /> {shop.productCount} imported</span>
              {shop.lastImportedAt && <span>last sync {new Date(shop.lastImportedAt).toLocaleDateString()}</span>}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-border px-5 flex gap-1 overflow-x-auto">
          <TabBtn active={tab === 'current'} onClick={() => setTab('current')} icon={<Database className="h-3.5 w-3.5" />} label={`Imported (${shop.productCount})`} disabled={shop.productCount === 0} />
          <TabBtn active={tab === 'browser'} onClick={() => setTab('browser')} icon={<Cloud className="h-3.5 w-3.5" />} label="Browse & add" disabled={!shop.importSourceUrl} />
          <TabBtn active={tab === 'source'} onClick={() => setTab('source')} icon={<Cloud className="h-3.5 w-3.5" />} label="Cloud API preview" disabled={!shop.importSourceUrl} />
          <TabBtn active={tab === 'ai'} onClick={() => setTab('ai')} icon={<Sparkles className="h-3.5 w-3.5" />} label={aiResult ? `AI risk · ${aiResult.score}/100` : 'AI risk analysis'} disabled={!shop.importSourceUrl} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {tab === 'current' && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold">Products currently in our catalogue from {shop.name}</h3>
                <p className="text-xs text-muted-foreground">page {dbPage} of {dbTotalPages} · {dbTotal} total</p>
              </div>
              {dbItems.length === 0 ? (
                <EmptyState icon={<Database className="h-10 w-10" />} title="No products yet" body="This shop has not been imported. Open the Source preview tab to fetch from the Cloud API." />
              ) : (
                <CardGrid items={dbItems} onPreview={setPreviewProduct} />
              )}
              {dbTotalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <Button variant="outline" size="sm" disabled={dbPage <= 1} onClick={() => loadDb(dbPage - 1)} className="rounded-full">← Prev</Button>
                  <Button variant="outline" size="sm" disabled={dbPage >= dbTotalPages} onClick={() => loadDb(dbPage + 1)} className="rounded-full">Next →</Button>
                </div>
              )}
            </section>
          )}

          {tab === 'browser' && shop.importSourceUrl && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-bold">Browse the supplier site</h3>
                <p className="text-xs text-muted-foreground">
                  Navigate the supplier just like a real browser. Every page is fetched through our admin proxy
                  (no scripts, no cookies leak). When you land on a product page, hit <strong>Add via AI</strong> in
                  the green toolbar — the URL importer extracts a draft. Already-imported URLs are flagged.
                </p>
              </div>
              <ShopBrowser initialUrl={shop.importSourceUrl} companySlug={shop.slug} />
            </section>
          )}

          {tab === 'source' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-bold">Cloud API preview (WooCommerce only)</h3>
                  <p className="text-xs text-muted-foreground">Only works for shops that publish a public WooCommerce Store API. Use <strong>Browse & add</strong> for any other supplier.</p>
                </div>
                <Button onClick={loadLive} disabled={liveLoading || !shop.importSourceUrl} size="sm" className="rounded-full font-semibold">
                  {liveLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {liveItems.length ? 'Refresh' : 'Fetch preview'}
                </Button>
              </div>

              {liveLoading && liveItems.length === 0 && (
                <div className="rounded-2xl border-2 border-dashed border-border bg-foreground/[0.02] p-10 text-center">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
                  <p className="text-sm font-semibold">Fetching {shop.importSourceUrl ? new URL(shop.importSourceUrl).hostname.replace(/^www\./, '') : 'source'}…</p>
                  <p className="text-xs text-muted-foreground mt-1">Hitting the WooCommerce Store API. Takes 1-10 seconds.</p>
                </div>
              )}

              {liveError && !liveLoading && (
                <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm">
                  <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Source preview unavailable</p>
                  <p className="text-xs mt-1.5 leading-relaxed">{liveError}</p>
                  <p className="text-xs mt-1.5 leading-relaxed text-red-700/80">
                    Most likely cause: this site is not a public WooCommerce store, or it blocks unauthenticated access. The AI suggestion may still be a real lab-equipment vendor — open the link in a new tab to verify by hand.
                  </p>
                  {shop.importSourceUrl && (
                    <a href={shop.importSourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold mt-2 text-red-800 hover:underline">
                      <ExternalLink className="h-3 w-3" /> Open {new URL(shop.importSourceUrl).hostname.replace(/^www\./, '')}
                    </a>
                  )}
                </div>
              )}

              {liveItems.length > 0 && (
                <>
                  <div className="rounded-xl border border-border bg-foreground/[0.02] p-3 flex items-center gap-4 flex-wrap text-xs">
                    <span><strong>{liveTotal}</strong> available in source</span>
                    <span className="text-emerald-700"><strong>{liveDeltaImported}</strong> already imported</span>
                    <span className="text-amber-700"><strong>{liveDeltaNew}</strong> new on this page</span>
                    <span className="ml-auto inline-flex gap-1.5">
                      <Button size="sm" variant="outline" onClick={selectAllNew} className="rounded-full text-xs">Select all new</Button>
                      <Button size="sm" variant="outline" onClick={selectNone} className="rounded-full text-xs">None</Button>
                    </span>
                  </div>
                  <CardGrid items={liveItems} onPreview={setPreviewProduct} selectable selected={selected} onToggle={toggleSelected} />
                  <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 border-t border-border bg-card/95 backdrop-blur px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-xs">
                      <strong className="tabular-nums">{selected.size}</strong> product{selected.size === 1 ? '' : 's'} selected
                      {importMsg && (
                        <span className={`ml-3 ${importMsg.ok ? 'text-emerald-700' : 'text-red-700'} font-semibold`}>
                          {importMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5 inline" /> : <XCircle className="h-3.5 w-3.5 inline" />} {importMsg.message}
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={runImportAll} disabled={importing} className="rounded-full font-semibold">
                        {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
                        Import all {liveTotal}
                      </Button>
                      <Button size="sm" onClick={runImportSelected} disabled={importing || selected.size === 0} className="rounded-full font-semibold">
                        {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                        Import {selected.size} selected
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'ai' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-bold">AI risk analysis</h3>
                  <p className="text-xs text-muted-foreground">
                    Claude evaluates the source URL for domain legitimacy, content quality and procurement risk.
                    {shop.aiAnalyzedAt && <> Last analysis: <strong>{new Date(shop.aiAnalyzedAt).toLocaleString()}</strong>.</>}
                  </p>
                </div>
                <Button onClick={runAi} disabled={aiLoading || !shop.importSourceUrl} size="sm" className="rounded-full font-semibold">
                  {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {aiResult ? 'Re-analyse' : 'Run AI analysis'}
                </Button>
              </div>

              {aiError && (
                <p className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold">{aiError}</p>
              )}

              {aiLoading && !aiResult && (
                <div className="rounded-2xl border-2 border-dashed border-purple-200 bg-purple-50 p-10 text-center">
                  <Loader2 className="h-8 w-8 animate-spin text-purple-600 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-purple-900">Claude is evaluating this source…</p>
                  <p className="text-xs text-purple-800 mt-1">Usually takes 5-15 seconds.</p>
                </div>
              )}

              {aiResult && (
                <div className={`rounded-2xl border ${verdictTone} p-5`}>
                  <div className="flex items-center gap-3 mb-3">
                    {verdict === 'safe' ? <ShieldCheck className="h-6 w-6" /> :
                     verdict === 'caution' ? <AlertTriangle className="h-6 w-6" /> :
                     <XCircle className="h-6 w-6" />}
                    <div>
                      <p className="text-2xl font-bold tabular-nums">{aiResult.score}<span className="text-base text-muted-foreground">/100</span></p>
                      <p className="text-[10px] uppercase tracking-wider font-bold">Verdict: {aiResult.verdict}</p>
                    </div>
                  </div>
                  <p className="text-sm leading-relaxed">{aiResult.notes}</p>
                </div>
              )}

              {!aiLoading && !aiResult && !aiError && (
                <EmptyState icon={<Sparkles className="h-10 w-10" />} title="No analysis yet" body="Click Run AI analysis to evaluate this source before importing." />
              )}
            </section>
          )}
        </div>

        {/* Footer with delete-suggested + close */}
        <div className="border-t border-border p-3 flex items-center justify-between gap-2 flex-wrap">
          {shop.suggestedByAi && shop.productCount === 0 ? (
            <Button variant="outline" onClick={dropShop} disabled={importing} className="rounded-full text-red-700 border-red-200 hover:bg-red-50">
              <Trash2 className="h-3.5 w-3.5" /> Block this supplier
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/products?shop=${shop.slug}`}
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded-full border border-border font-semibold text-xs hover:bg-foreground/5"
            >
              <Eye className="h-3.5 w-3.5" /> View in product list
            </Link>
            <Button variant="ghost" onClick={onClose} className="rounded-full">Close</Button>
          </div>
        </div>
      </div>

      {/* Per-product preview modal */}
      {previewProduct && (
        <ProductCardPreview product={previewProduct} onClose={() => setPreviewProduct(null)} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label, disabled }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold whitespace-nowrap transition-colors ${
        active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {icon} {label}
      {active && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-t" />}
    </button>
  );
}

function CardGrid({
  items, onPreview, selectable, selected, onToggle,
}: {
  items: PreviewProductCard[];
  onPreview: (p: PreviewProductCard) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (slug: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {items.map((p) => {
        const key = p.sourceSlug ?? p.slug;
        const isSelected = selectable && selected?.has(key);
        return (
          <li key={key} className={`relative rounded-xl border bg-card overflow-hidden transition-colors ${
            isSelected ? 'border-primary ring-2 ring-primary/30' : p.alreadyImported ? 'border-emerald-200' : 'border-border'
          }`}>
            <div className="aspect-[4/3] bg-muted relative overflow-hidden">
              {p.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.image} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">no photo</div>
              )}
              {p.alreadyImported && (
                <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 text-[9px] font-bold uppercase">
                  ✓ in catalogue
                </span>
              )}
              {p.status === 'DRAFT' && (
                <span className="absolute top-1 left-1 inline-flex px-1.5 py-0.5 rounded-full bg-foreground/70 text-background text-[9px] font-bold uppercase">draft</span>
              )}
              {selectable && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggle?.(key); }}
                  className={`absolute top-1 right-1 h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    isSelected ? 'bg-primary text-primary-foreground' : 'bg-background/90 text-foreground border border-border'
                  }`}
                  aria-label={isSelected ? 'Deselect' : 'Select'}
                >
                  {isSelected ? '✓' : ''}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onPreview(p)}
              className="block w-full text-left p-2.5 hover:bg-foreground/[0.03] transition-colors"
            >
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground truncate">{p.brand ?? '—'}</p>
              <p className="text-xs font-semibold line-clamp-2 leading-snug min-h-[2.4em]">{p.title}</p>
              <p className="text-xs font-bold tabular-nums mt-1">{fmtPrice(p.priceCents, p.currency)}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-border bg-foreground/[0.02] p-10 text-center">
      <div className="text-muted-foreground mx-auto w-fit mb-3">{icon}</div>
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground mt-1">{body}</p>
    </div>
  );
}

function ProductCardPreview({ product, onClose }: { product: PreviewProductCard; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal>
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-label="Close" />
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-2xl shadow-xl m-4 overflow-hidden">
        <div className="p-4 border-b border-border flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Marketplace card preview</h3>
            <p className="text-xs text-muted-foreground mt-0.5">How buyers will see this product on the catalogue grid.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-foreground/5"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 bg-foreground/[0.02]">
          {/* Mock of the marketplace card */}
          <div className="max-w-[280px] mx-auto rounded-2xl border border-border bg-card overflow-hidden shadow-sm hover:shadow-md transition-shadow">
            <div className="aspect-[4/3] bg-muted relative overflow-hidden">
              {product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={product.image} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] flex items-center justify-center text-muted-foreground text-sm">no photo</div>
              )}
            </div>
            <div className="p-4 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{product.brand ?? '—'}</p>
              <p className="font-semibold leading-snug line-clamp-2 min-h-[2.6em]">{product.title}</p>
              <div className="flex items-center justify-between pt-2">
                <span className="text-lg font-bold tabular-nums">{fmtPrice(product.priceCents, product.currency)}</span>
                <span className="text-[10px] uppercase tracking-wider font-bold text-primary">View →</span>
              </div>
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-border flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground truncate">slug: <code>{product.slug}</code></p>
          {!product.alreadyImported ? (
            <span className="text-xs font-semibold text-amber-700 inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> Not in catalogue yet
            </span>
          ) : (
            <Link href={`/marketplace/${product.slug}`} target="_blank" className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1">
              <ExternalLink className="h-3.5 w-3.5" /> Open on marketplace
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
