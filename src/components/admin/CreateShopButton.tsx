'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, X, Loader2, Globe, Sparkles, ShieldCheck, AlertTriangle, ExternalLink, ArrowLeft, ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  createCompany,
  importShopProducts,
  previewShopLive,
  aiAnalyzeShop,
  type PreviewProductCard,
} from '@/app/admin/actions';

type Step = 'enter' | 'preview' | 'confirm';

interface PreviewState {
  items: PreviewProductCard[];
  total: number;
  existingCount: number;
}
interface AiState {
  score: number;
  verdict: 'safe' | 'caution' | 'risky';
  notes: string;
}

function fmtPrice(cents: number | null, currency: string) {
  if (cents == null) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

export function CreateShopButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('enter');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [website, setWebsite] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importNow, setImportNow] = useState(true);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [ai, setAi] = useState<AiState | null>(null);
  const [previewing, startPreview] = useTransition();
  const [committing, startCommit] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  function reset() {
    setStep('enter'); setName(''); setCountry(''); setWebsite('');
    setImportUrl(''); setImportNow(true); setPreview(null); setAi(null);
    setError(null); setSuccessMsg(null);
  }

  function runPreview() {
    setError(null); setPreview(null); setAi(null);
    if (name.trim().length < 2) { setError('Shop name must be at least 2 characters.'); return; }
    if (importUrl && !/^https?:\/\//i.test(importUrl)) { setError('Import URL must start with http:// or https://'); return; }
    if (!importUrl) {
      // No import URL — skip preview, go straight to confirm
      setStep('confirm'); return;
    }
    startPreview(async () => {
      const [pr, ar] = await Promise.all([
        previewShopLive(importUrl, 1, 12),
        aiAnalyzeShop(importUrl),
      ]);
      if (!pr.ok) { setError(`Live source preview failed: ${pr.message}`); return; }
      setPreview({ items: pr.items, total: pr.total, existingCount: pr.existingCount ?? 0 });
      if (ar.ok && ar.result) setAi(ar.result);
      else setAi({ score: 50, verdict: 'caution', notes: ar.message ?? 'AI analysis unavailable.' });
      setStep('preview');
    });
  }

  function commit() {
    setError(null);
    startCommit(async () => {
      const r = await createCompany({
        name: name.trim(),
        country: country.trim() || null,
        website: website.trim() || null,
        importSourceUrl: importUrl.trim() || null,
      });
      if (!r.ok) { setError(r.message); return; }
      if (importUrl && importNow && r.slug) {
        setSuccessMsg('Shop created. Importing products…');
        const ir = await importShopProducts(r.slug, null);
        if (ir.ok) {
          router.push(`/admin/companies?imported=${ir.imported ?? 0}`);
          return;
        }
        setError(`Shop created but import failed: ${ir.message}`);
        return;
      }
      router.push(`/admin/companies?created=${encodeURIComponent(name.trim())}`);
    });
  }

  const verdictTone = ai && (
    ai.verdict === 'safe' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' :
    ai.verdict === 'caution' ? 'border-amber-200 bg-amber-50 text-amber-900' :
    'border-red-200 bg-red-50 text-red-900'
  );

  return (
    <>
      <Button onClick={() => { reset(); setOpen(true); }} className="rounded-full font-semibold">
        <Plus className="h-4 w-4" /> Add shop
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <button type="button" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close" />
          <div className="relative w-full max-w-2xl bg-card border border-border rounded-2xl shadow-xl m-4 max-h-[92vh] flex flex-col">
            {/* Header with step indicator */}
            <div className="p-5 border-b border-border flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Add a shop</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {step === 'enter' && 'Enter shop details — you’ll preview imported products before anything is added to the catalogue.'}
                  {step === 'preview' && 'Live preview + AI risk assessment. Nothing has been written to the database yet.'}
                  {step === 'confirm' && 'Final confirmation — proceed will create the shop and (optionally) import its catalogue.'}
                </p>
                <StepDots step={step} />
              </div>
              <button type="button" onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-foreground/5">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5 space-y-3 overflow-auto flex-1">
              {step === 'enter' && (
                <>
                  <Field label="Shop name (required)">
                    <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="Lab2Parts" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Country">
                      <input value={country} onChange={(e) => setCountry(e.target.value)} className={input} placeholder="Netherlands" />
                    </Field>
                    <Field label="Public website">
                      <input value={website} onChange={(e) => setWebsite(e.target.value)} className={input} placeholder="https://…" />
                    </Field>
                  </div>
                  <Field
                    label={<span className="inline-flex items-center gap-1.5"><Globe className="h-3.5 w-3.5 text-primary" /> Import URL (Woo Store API base)</span>}
                    hint="https://shop.example.com — we hit /wp-json/wc/store/v1 ourselves. Leave blank for a manual shop with no auto-import."
                  >
                    <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} className={input} placeholder="https://lab2parts.com" />
                  </Field>
                  {importUrl && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input type="checkbox" checked={importNow} onChange={(e) => setImportNow(e.target.checked)} />
                      Import the catalogue immediately after the preview check passes
                    </label>
                  )}
                </>
              )}

              {step === 'preview' && (
                <>
                  {ai && (
                    <div className={`rounded-2xl border ${verdictTone} p-4 flex items-start gap-3`}>
                      {ai.verdict === 'safe' ? <ShieldCheck className="h-6 w-6 flex-shrink-0" /> :
                       <AlertTriangle className="h-6 w-6 flex-shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wider font-bold opacity-70">AI risk verdict</p>
                        <p className="text-lg font-bold tabular-nums">
                          {ai.score}/100 · {ai.verdict}
                        </p>
                        <p className="text-sm leading-relaxed mt-1">{ai.notes}</p>
                      </div>
                    </div>
                  )}

                  {preview && (
                    <>
                      <div className="rounded-xl border border-border bg-foreground/[0.02] p-3 flex items-center gap-4 flex-wrap text-xs">
                        <span><strong className="tabular-nums">{preview.total}</strong> products in source</span>
                        <span className="text-emerald-700"><strong>{preview.existingCount}</strong> already in catalogue</span>
                        <span className="text-amber-700"><strong>{preview.items.length - preview.existingCount}</strong> new on first page</span>
                        <a href={importUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                          <ExternalLink className="h-3 w-3" /> open source
                        </a>
                      </div>
                      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Sample (first 12)</p>
                      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                        {preview.items.map((p) => (
                          <li key={p.slug} className="rounded-xl border border-border bg-card overflow-hidden">
                            <div className="aspect-[4/3] bg-muted">
                              {p.image && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={p.image} alt="" className="w-full h-full object-cover" />
                              )}
                            </div>
                            <div className="p-2 space-y-0.5">
                              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground truncate">{p.brand ?? '—'}</p>
                              <p className="text-xs font-semibold line-clamp-2 leading-snug min-h-[2.4em]">{p.title}</p>
                              <p className="text-xs font-bold tabular-nums">{fmtPrice(p.priceCents, p.currency)}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}

              {step === 'confirm' && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
                  <ShieldCheck className="h-10 w-10 mx-auto text-emerald-700 mb-2" />
                  <p className="font-semibold text-emerald-900">Ready to create</p>
                  <p className="text-sm text-emerald-800 mt-1">
                    {importUrl
                      ? <>“{name}” will be created with import source <strong>{importUrl}</strong>{importNow ? ', and the catalogue will be imported immediately.' : ' — no products will be imported yet.'}</>
                      : <>“{name}” will be created as a manual shop with no auto-import.</>}
                  </p>
                  {successMsg && <p className="text-xs text-emerald-900 font-semibold mt-3">{successMsg}</p>}
                </div>
              )}

              {error && (
                <p className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> {error}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-border flex justify-between gap-2">
              {step !== 'enter' ? (
                <Button variant="ghost" onClick={() => setStep('enter')} className="rounded-full">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setOpen(false)} className="rounded-full">Cancel</Button>
              )}

              {step === 'enter' && (
                <Button onClick={runPreview} disabled={previewing || !name.trim()} className="rounded-full font-semibold">
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {importUrl ? 'Preview + AI check' : 'Continue'}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}

              {step === 'preview' && (
                <Button onClick={() => setStep('confirm')} disabled={ai?.verdict === 'risky'} className="rounded-full font-semibold">
                  Looks good <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}

              {step === 'confirm' && (
                <Button onClick={commit} disabled={committing} className="rounded-full font-semibold">
                  {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {importUrl && importNow ? `Create + import ${preview?.total ?? ''}` : 'Create shop'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ['enter', 'preview', 'confirm'];
  const idx = order.indexOf(step);
  return (
    <div className="flex items-center gap-1.5 mt-2 text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
      {order.map((s, i) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`h-1.5 w-6 rounded-full ${i <= idx ? 'bg-primary' : 'bg-foreground/10'}`} />
          <span className={i === idx ? 'text-foreground' : ''}>{s}</span>
        </span>
      ))}
    </div>
  );
}

const input = 'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

function Field({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground mb-1.5">{hint}</span>}
      {children}
    </label>
  );
}
