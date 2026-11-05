'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Eye, Loader2, Plus, Send, Trash2, X } from 'lucide-react';
import { sendProforma } from '@/lib/quotes/actions';
import { testVat } from '@/app/admin/documents/actions';
import { formatPrice } from '@/lib/utils';

export interface ProformaDefaults {
  itemTitle: string;
  unitCents: number | null;
  qty: number;
  mainDetail: string;
  extraLines: { title: string; detail?: string | null; qty: number; unitCents: number }[];
  shippingCents: number;
  billing: { name: string; company: string; address: string; country: string; vatId: string };
  vatTreatment: 'AUTO' | 'DOMESTIC' | 'REVERSE_CHARGE' | 'EXPORT';
  validDays: number;
  lang: 'en' | 'nl';
  note: string;
  allowOverride: boolean;
  standardRatePct: number;
}

const input = 'h-10 w-full px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';
const label = 'block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1';

function euroToCents(v: string): number {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
function centsToEuro(c: number | null | undefined): string {
  return c == null ? '' : (c / 100).toFixed(2);
}

/**
 * The structured quote composer: lines, shipping, the buyer's billing block
 * (with a live VIES check), VAT treatment, validity, language and a PDF
 * preview of exactly what will be sent.
 */
export function ProformaComposer({ quoteId, buyerEmail, d, onDone }: { quoteId: string; buyerEmail: string; d: ProformaDefaults; onDone: () => void }) {
  const [price, setPrice] = useState(centsToEuro(d.unitCents));
  const [qty, setQty] = useState(String(d.qty || 1));
  const [mainTitle, setMainTitle] = useState(d.itemTitle);
  const [mainDetail, setMainDetail] = useState(d.mainDetail);
  const [lines, setLines] = useState(d.extraLines.map((l) => ({ title: l.title, detail: l.detail ?? '', qty: String(l.qty), price: centsToEuro(l.unitCents) })));
  const [shipping, setShipping] = useState(d.shippingCents ? centsToEuro(d.shippingCents) : '');
  const [billing, setBilling] = useState(d.billing);
  const [vat, setVat] = useState(d.vatTreatment);
  const [validDays, setValidDays] = useState(String(d.validDays));
  const [lang, setLang] = useState(d.lang);
  const [note, setNote] = useState(d.note);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [checking, startCheck] = useTransition();
  const lastCheck = useRef('');

  const payload = useMemo(() => {
    return {
      mainTitle,
      mainDetail: mainDetail || null,
      extraLines: lines.filter((l) => l.title.trim()).map((l) => ({ title: l.title.trim(), detail: l.detail || null, qty: Number(l.qty) || 1, unitCents: euroToCents(l.price) || 0 })),
      shippingCents: shipping ? Math.max(0, euroToCents(shipping) || 0) : 0,
      billing,
      vatTreatment: vat,
      validDays: Number(validDays) || d.validDays,
      lang,
    };
  }, [mainTitle, mainDetail, lines, shipping, billing, vat, validDays, lang, d.validDays]);

  // Estimated totals (the server recomputes with the real VAT decision).
  const unit = euroToCents(price);
  const q = Math.max(1, Math.round(Number(qty) || 1));
  const goods = (Number.isFinite(unit) ? unit * q : 0) + payload.extraLines.reduce((s, l) => s + Math.round(l.unitCents * l.qty), 0);
  const base = goods + payload.shippingCents;

  // Live VAT suggestion from the billing country + VAT ID (debounced).
  useEffect(() => {
    const key = `${billing.country}|${billing.vatId}`;
    if (key === lastCheck.current) return;
    const t = setTimeout(() => {
      lastCheck.current = key;
      startCheck(async () => {
        const r = await testVat(billing.country, billing.vatId);
        if (!r.ok || !r.decision) { setSuggest(null); return; }
        const dcs = r.decision;
        const what = dcs.treatment === 'DOMESTIC' ? `${dcs.rateBp / 100}% VAT` : dcs.treatment === 'REVERSE_CHARGE' ? 'reverse charge, 0%' : dcs.treatment === 'EXPORT' ? 'export, 0%' : 'needs your choice';
        setSuggest({ text: `Suggested: ${what}. ${dcs.reason}`, tone: dcs.treatment === 'REVIEW' ? 'warn' : 'ok' });
      });
    }, 700);
    return () => clearTimeout(t);
  }, [billing.country, billing.vatId]);

  function firstProblem(): string | null {
    if (!Number.isFinite(unit) || unit <= 0) return 'Enter a valid unit price.';
    if (q < 1) return 'Enter a quantity of 1 or more.';
    if (lines.some((l) => l.title.trim() && !Number.isFinite(euroToCents(l.price)))) return 'Every extra line needs a price (0 is allowed).';
    return null;
  }

  function run(mode: 'preview' | 'send', confirmIncomplete = false, confirmOverStock = false) {
    setErr(null);
    setNotice(null);
    const bad = firstProblem();
    if (bad) { setErr(bad); return; }
    start(async () => {
      try {
        const r = await sendProforma({
          sourcingRequestId: quoteId,
          priceCents: unit,
          quantity: q,
          currency: 'EUR',
          note: note.trim() || null,
          compose: payload,
          previewOnly: mode === 'preview',
          confirmIncomplete,
          confirmOverStock,
        });
        if (r?.error) { setErr(r.error); return; }
        if (r?.confirm) {
          if (confirm(r.confirm)) run('send', true, confirmOverStock);
          return;
        }
        // More units than the listing holds: ask, then resend with the confirm.
        if (r?.needsConfirm) {
          if (window.confirm(r.needsConfirm)) run('send', confirmIncomplete, true);
          return;
        }
        if (mode === 'preview') { setPreview(r.previewHtml ?? null); return; }
        if (r?.notice) setNotice(r.notice);
        onDone();
      } catch (e) {
        if ((e as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setErr('Not sent. Reload the page and try again.');
      }
    });
  }

  return (
    <div className="p-5 space-y-5">
      {/* Lines */}
      <div className="space-y-2">
        <span className={label}>Lines</span>
        <div className="rounded-xl border border-border p-3 space-y-2 bg-background/60">
          <input className={input} value={mainTitle} onChange={(e) => setMainTitle(e.target.value)} aria-label="Main line description" />
          <input className={`${input} h-9 text-xs`} value={mainDetail} onChange={(e) => setMainDetail(e.target.value)} placeholder="Second line (optional): serial, condition, lead time…" aria-label="Main line detail" />
          <div className="flex items-center gap-2 flex-wrap">
            <input type="number" min="0.01" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Unit price €" aria-label="Unit price in euro" required className={`${input} w-40`} />
            <span className="text-sm text-muted-foreground">×</span>
            <input type="number" min="1" max="9999" step="1" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" className={`${input} w-24`} />
          </div>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="rounded-xl border border-border p-3 space-y-2 bg-background/60">
            <div className="flex gap-2">
              <input className={input} value={l.title} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Description, e.g. Calibration and installation" aria-label={`Line ${i + 2} description`} />
              <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="h-10 w-10 shrink-0 rounded-lg border border-border inline-flex items-center justify-center hover:bg-foreground/[0.04]" aria-label={`Remove line ${i + 2}`}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="number" step="0.01" value={l.price} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} placeholder="Unit price € (negative = discount)" aria-label={`Line ${i + 2} unit price`} className={`${input} w-56`} />
              <span className="text-sm text-muted-foreground">×</span>
              <input type="number" min="1" step="1" value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label={`Line ${i + 2} quantity`} className={`${input} w-24`} />
            </div>
          </div>
        ))}
        <button type="button" onClick={() => setLines((p) => [...p, { title: '', detail: '', qty: '1', price: '' }])} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-foreground/[0.04]">
          <Plus className="h-3.5 w-3.5" /> Add a line
        </button>
        <label className="block max-w-xs">
          <span className={label}>Shipping (€, excl. VAT)</span>
          <input type="number" min="0" step="0.01" value={shipping} onChange={(e) => setShipping(e.target.value)} placeholder="0.00" className={input} />
        </label>
      </div>

      {/* Billing */}
      <div className="space-y-2">
        <span className={label}>Customer on the quote</span>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={input} value={billing.company} onChange={(e) => setBilling((b) => ({ ...b, company: e.target.value }))} placeholder="Company" aria-label="Customer company" />
          <input className={input} value={billing.name} onChange={(e) => setBilling((b) => ({ ...b, name: e.target.value }))} placeholder="Contact name" aria-label="Customer contact name" />
          <textarea className={`${input} h-auto py-2 sm:col-span-2`} rows={2} value={billing.address} onChange={(e) => setBilling((b) => ({ ...b, address: e.target.value }))} placeholder={'Street and number\nPostcode City'} aria-label="Customer address" />
          <input className={`${input} uppercase`} maxLength={2} value={billing.country} onChange={(e) => setBilling((b) => ({ ...b, country: e.target.value.toUpperCase() }))} placeholder="Country (NL, DE, US…)" aria-label="Customer country code" />
          <input className={`${input} font-mono`} value={billing.vatId} onChange={(e) => setBilling((b) => ({ ...b, vatId: e.target.value }))} placeholder="EU VAT ID (for reverse charge)" aria-label="Customer VAT ID" />
        </div>
        {(suggest || checking) && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${suggest?.tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-border bg-background text-muted-foreground'}`}>
            {checking ? 'Checking VAT…' : suggest?.text}
          </p>
        )}
      </div>

      {/* VAT, validity, language */}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={label}>VAT</span>
          <select className={input} value={vat} onChange={(e) => setVat(e.target.value as ProformaDefaults['vatTreatment'])} disabled={!d.allowOverride && vat === 'AUTO'}>
            <option value="AUTO">Automatic (suggested)</option>
            {d.allowOverride && <option value="DOMESTIC">Standard {d.standardRatePct}%</option>}
            {d.allowOverride && <option value="REVERSE_CHARGE">EU reverse charge 0%</option>}
            {d.allowOverride && <option value="EXPORT">Export 0%</option>}
          </select>
        </label>
        <label className="block">
          <span className={label}>Valid for (days)</span>
          <input type="number" min="1" max="365" className={input} value={validDays} onChange={(e) => setValidDays(e.target.value)} />
        </label>
        <label className="block">
          <span className={label}>Language</span>
          <select className={input} value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'nl')}>
            <option value="en">English</option>
            <option value="nl">Dutch</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className={label}>Note on the quote (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 1500))} rows={3} maxLength={1500} placeholder="Lead time, condition, what's included…" className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
      </label>

      <div className="rounded-lg bg-accent/[0.10] border border-accent/30 px-3 py-2 text-xs">
        Goods {formatPrice(goods, 'EUR')}{payload.shippingCents ? ` + shipping ${formatPrice(payload.shippingCents, 'EUR')}` : ''}
        {vat === 'REVERSE_CHARGE' || vat === 'EXPORT' ? ' + 0% VAT' : vat === 'DOMESTIC' ? ` + ${d.standardRatePct}% VAT ≈ ${formatPrice(Math.round(base * (1 + d.standardRatePct / 100)), 'EUR')}` : ' + VAT as suggested above'}
        <span className="block text-muted-foreground mt-0.5">“Preview PDF” shows the exact totals.</span>
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">{err}</p>}
      {notice && <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">{notice}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted-foreground">Sends the quote PDF to {buyerEmail}.</span>
        <span className="flex-1" />
        <button type="button" disabled={pending} onClick={() => run('preview')} className="rounded-full border border-border bg-background px-5 h-10 text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/[0.04] disabled:opacity-60">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview PDF
        </button>
        <button type="button" disabled={pending} onClick={() => run('send')} className="rounded-full bg-accent text-accent-foreground hover:bg-accent/90 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send quote
        </button>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch justify-center p-2 sm:p-6" role="dialog" aria-label="Quote preview">
          <div className="bg-card rounded-2xl w-full max-w-4xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 p-3 border-b border-border">
              <p className="text-sm font-semibold">Preview — this is what {buyerEmail} receives as PDF</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setPreview(null); run('send'); }} className="rounded-full bg-accent text-accent-foreground px-4 h-9 text-sm font-bold inline-flex items-center gap-2"><Send className="h-4 w-4" /> Send quote</button>
                <button type="button" onClick={() => setPreview(null)} className="h-9 w-9 rounded-full border border-border inline-flex items-center justify-center" aria-label="Close preview"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <iframe title="Quote preview" sandbox="" srcDoc={preview} className="flex-1 w-full bg-white" />
          </div>
        </div>
      )}
    </div>
  );
}
