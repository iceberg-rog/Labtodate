'use client';

import { useActionState, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink, Eye, History, Loader2, RotateCcw, Send, XCircle } from 'lucide-react';
import {
  previewEmail,
  resetToDefault,
  restoreVersion,
  saveCompanyDetails,
  saveDocOptions,
  saveDocTexts,
  saveEmailLayout,
  saveEmailTexts,
  saveGeneralSettings,
  saveLabels,
  saveNumberingSettings,
  saveVatSettings,
  sendTestDocument,
  sendTestEmail,
  setEmailEnabled,
  testVat,
  versionsOf,
  type ActionResult,
} from '@/app/admin/documents/actions';

// ─── shared bits ───────────────────────────────────────────────────────

export const inputCls =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';
export const areaCls =
  'w-full px-3 py-2 rounded-lg border border-input bg-background text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary font-[inherit]';
const btn = 'inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg text-sm font-semibold transition disabled:opacity-50';
const btnPrimary = `${btn} bg-primary text-primary-foreground hover:opacity-90`;
const btnGhost = `${btn} border border-border bg-background hover:bg-foreground/[0.04]`;

export interface Field {
  name: string;
  label: string;
  example: string;
}

function Status({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return (
    <div
      role="status"
      className={`rounded-lg border px-3 py-2 text-sm ${r.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}
    >
      <p className="font-semibold inline-flex items-center gap-1.5">
        {r.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {r.message}
      </p>
      {r.problems && r.problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5 space-y-0.5">
          {r.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Inserts {{field}} at the cursor of the last focused text box inside `scope`. */
function useInsertTarget() {
  const last = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const onFocusCapture = useCallback((e: React.FocusEvent) => {
    const t = e.target as HTMLElement;
    if (t.dataset.noInsert !== undefined) return; // the Insert field menu's own search box
    if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === 'text')) last.current = t;
  }, []);
  const insert = useCallback((text: string, onChange: (name: string, value: string) => void) => {
    const el = last.current;
    if (!el) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const value = el.value.slice(0, start) + text + el.value.slice(end);
    onChange(el.name, value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
    return true;
  }, []);
  return { onFocusCapture, insert };
}

function InsertField({ fields, onPick }: { fields: Field[]; onPick: (f: Field) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = fields.filter((f) => !q || `${f.label} ${f.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative">
      <button type="button" className={btnGhost} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Insert field <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 right-0 w-80 max-h-80 overflow-auto rounded-xl border border-border bg-popover shadow-xl p-2">
          <input autoFocus data-no-insert="" className={`${inputCls} h-8 mb-2`} placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.map((f) => (
            <button
              key={f.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(f);
                setOpen(false);
              }}
              className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-foreground/[0.05]"
            >
              <span className="block text-sm font-semibold">{f.label}</span>
              <span className="block text-[11px] text-muted-foreground font-mono">{`{{${f.name}}}`} · e.g. {f.example}</span>
            </button>
          ))}
          {!list.length && <p className="text-xs text-muted-foreground p-2">No field matches.</p>}
        </div>
      )}
    </div>
  );
}

function FormatHelp() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Format: <code>**bold**</code> · a line starting with <code>- </code> is a bullet · an empty line starts a new paragraph · fields look like{' '}
      <code>{'{{customer.name}}'}</code> (use “Insert field”). HTML is shown as plain text.
    </p>
  );
}

// ─── live document preview ─────────────────────────────────────────────

export function DocPreview({
  kind,
  lang,
  override,
  sources,
}: {
  kind: string;
  lang: string;
  override: Record<string, unknown>;
  sources: { value: string; label: string }[];
}) {
  const [source, setSource] = useState(sources[0]?.value ?? 'sample:nl');
  const [html, setHtml] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testRes, setTestRes] = useState<ActionResult | null>(null);
  const [sending, startSend] = useTransition();
  const body = useMemo(() => JSON.stringify({ kind, lang, source, override }), [kind, lang, source, override]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch('/api/admin/documents/preview?format=html', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: ctl.signal });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        setHtml(await res.text());
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [body]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 794)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function openPdf() {
    const w = window.open('', '_blank');
    try {
      const res = await fetch('/api/admin/documents/preview', { method: 'POST', body: JSON.stringify({ ...JSON.parse(body), stash: true }), headers: { 'Content-Type': 'application/json' } });
      const { id } = (await res.json()) as { id: string };
      if (w) w.location.href = `/api/admin/documents/preview?id=${encodeURIComponent(id)}`;
    } catch {
      w?.close();
      setErr('Could not open the PDF.');
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-3 space-y-3 lg:sticky lg:top-4">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-semibold text-muted-foreground" htmlFor="pv-src">Preview with</label>
        <select id="pv-src" className={`${inputCls} h-8 w-auto max-w-full text-xs`} value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">{busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…</> : 'Live'}</span>
        <button type="button" className={`${btnGhost} h-8 ml-auto`} onClick={openPdf}>
          <ExternalLink className="h-3.5 w-3.5" /> View PDF
        </button>
      </div>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <div ref={wrapRef} className="w-full overflow-hidden rounded-lg border border-border bg-white" style={{ height: `${Math.round(1123 * scale)}px` }}>
        <iframe
          title="Document preview"
          srcDoc={html}
          sandbox=""
          style={{ width: 794, height: 1123, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0, background: '#fff' }}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap border-t border-border pt-3">
        <input className={`${inputCls} h-8 flex-1 min-w-[12rem]`} type="email" placeholder="Send a test to this address" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <button
          type="button"
          className={`${btnGhost} h-8`}
          disabled={sending}
          onClick={() =>
            startSend(async () => {
              setTestRes(await sendTestDocument({ kind, lang, source, to: testTo, override }));
            })
          }
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send test
        </button>
      </div>
      <Status r={testRes} />
      <p className="text-[11px] text-muted-foreground">
        The preview shows your unsaved changes. Documents already sent never change — new templates apply to new documents only.
      </p>
    </div>
  );
}

// ─── document texts + options ──────────────────────────────────────────

type TextField = { key: string; label: string; rich: boolean; max: number };

export function TemplateEditor(props: {
  kind: string;
  lang: string;
  textFields: TextField[];
  initialTexts: Record<string, string>;
  initialOptions: Record<string, boolean | number>;
  fields: Field[];
  sources: { value: string; label: string }[];
  hints: Record<string, string>;
}) {
  const [texts, setTexts] = useState(props.initialTexts);
  const [options, setOptions] = useState(props.initialOptions);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [optRes, setOptRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const { onFocusCapture, insert } = useInsertTarget();
  const set = (name: string, value: string) => setTexts((t) => ({ ...t, [name]: value }));
  const dirty = JSON.stringify(texts) !== JSON.stringify(props.initialTexts);
  const optDirty = JSON.stringify(options) !== JSON.stringify(props.initialOptions);
  const override = useMemo(() => ({ texts, options }), [texts, options]);
  const daysLabel = props.kind === 'QUOTE' ? 'Valid for (days)' : props.kind === 'INVOICE' ? 'Payment term (days)' : '';

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="space-y-5 min-w-0">
        <section className="rounded-2xl border border-border bg-card p-5 space-y-4" onFocusCapture={onFocusCapture}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Texts ({props.lang.toUpperCase()})</h2>
            <InsertField fields={props.fields} onPick={(f) => { if (!insert(`{{${f.name}}}`, set)) setRes({ ok: false, message: 'Click into a text box first, then insert the field.' }); }} />
          </div>
          {props.textFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-sm font-semibold" htmlFor={`t-${f.key}`}>{f.label}</label>
              {f.rich ? (
                <textarea id={`t-${f.key}`} name={f.key} rows={f.key === 'footer' ? 2 : 3} className={areaCls} value={texts[f.key] ?? ''} maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input id={`t-${f.key}`} name={f.key} type="text" className={inputCls} value={texts[f.key] ?? ''} maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} />
              )}
              {props.hints[f.key] && <p className="text-[11px] text-muted-foreground">{props.hints[f.key]}</p>}
            </div>
          ))}
          <FormatHelp />
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={btnPrimary} disabled={pending || !dirty} onClick={() => start(async () => setRes(await saveDocTexts(props.kind, props.lang, texts)))}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save texts
            </button>
            <button type="button" className={btnGhost} disabled={pending || !dirty} onClick={() => setTexts(props.initialTexts)}>Discard changes</button>
            <button
              type="button"
              className={`${btnGhost} ml-auto`}
              disabled={pending}
              onClick={() => {
                if (confirm('Replace these texts with the built-in defaults? The current version stays in History.')) start(async () => { const r = await resetToDefault(`doc:texts:${props.kind}:${props.lang}`); setRes(r); if (r.ok) location.reload(); });
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset to default
            </button>
          </div>
          <Status r={res} />
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Options (all languages)</h2>
          {([
            ['showLogo', 'Show the logo'],
            ['showGreeting', 'Start with the greeting'],
            ['showBankDetails', props.kind === 'RECEIPT' ? 'Show bank details (not used on receipts)' : 'Show the payment box with the bank details'],
            ['showCustomerNo', 'Show the customer number'],
            ...(props.kind === 'QUOTE' ? [['showSignature', 'Signature block (“Agreed by the customer”)']] : []),
          ] as [string, string][]).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary h-4 w-4" checked={!!options[k]} onChange={(e) => setOptions((o) => ({ ...o, [k]: e.target.checked }))} />
              {label}
            </label>
          ))}
          {daysLabel && (
            <label className="block text-sm font-semibold max-w-xs">
              {daysLabel}
              <input type="number" min={props.kind === 'QUOTE' ? 1 : 0} max={365} className={`${inputCls} mt-1`} value={Number(options.days ?? 0)} onChange={(e) => setOptions((o) => ({ ...o, days: Number(e.target.value) }))} />
            </label>
          )}
          <div className="flex items-center gap-2">
            <button type="button" className={btnPrimary} disabled={pending || !optDirty} onClick={() => start(async () => setOptRes(await saveDocOptions(props.kind, options as Record<string, unknown>)))}>Save options</button>
          </div>
          <Status r={optRes} />
        </section>
      </div>
      <DocPreview kind={props.kind} lang={props.lang} override={override} sources={props.sources} />
    </div>
  );
}

export function LabelsEditor(props: {
  lang: string;
  labelFields: { key: string; label: string; group: string; rich?: boolean }[];
  initial: Record<string, string>;
  fields: Field[];
  sources: { value: string; label: string }[];
}) {
  const [labels, setLabels] = useState(props.initial);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [kind, setKind] = useState('QUOTE');
  const { onFocusCapture, insert } = useInsertTarget();
  const set = (name: string, value: string) => setLabels((t) => ({ ...t, [name]: value }));
  const groups = Array.from(new Set(props.labelFields.map((f) => f.group)));
  const dirty = JSON.stringify(labels) !== JSON.stringify(props.initial);
  const override = useMemo(() => ({ labels }), [labels]);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <section className="rounded-2xl border border-border bg-card p-5 space-y-4 min-w-0" onFocusCapture={onFocusCapture}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Labels on every document ({props.lang.toUpperCase()})</h2>
          <InsertField fields={props.fields} onPick={(f) => { if (!insert(`{{${f.name}}}`, set)) setRes({ ok: false, message: 'Click into a text box first, then insert the field.' }); }} />
        </div>
        {groups.map((g) => (
          <fieldset key={g} className="space-y-2">
            <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">{g}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {props.labelFields.filter((f) => f.group === g).map((f) => (
                <label key={f.key} className={`block text-xs font-semibold ${f.rich ? 'sm:col-span-2' : ''}`}>
                  {f.label}
                  {f.rich ? (
                    <textarea name={f.key} rows={3} className={`${areaCls} mt-1`} value={labels[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                  ) : (
                    <input name={f.key} type="text" className={`${inputCls} mt-1 h-9`} value={labels[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className={btnPrimary} disabled={pending || !dirty} onClick={() => start(async () => setRes(await saveLabels(props.lang, labels)))}>Save labels</button>
          <button type="button" className={btnGhost} disabled={!dirty} onClick={() => setLabels(props.initial)}>Discard changes</button>
          <button type="button" className={`${btnGhost} ml-auto`} onClick={() => { if (confirm('Replace all labels with the built-in defaults? The current version stays in History.')) start(async () => { const r = await resetToDefault(`doc:labels:${props.lang}`); setRes(r); if (r.ok) location.reload(); }); }}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
        </div>
        <Status r={res} />
      </section>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-muted-foreground">Preview on</span>
          {['QUOTE', 'INVOICE', 'RECEIPT'].map((k) => (
            <button key={k} type="button" className={`${btnGhost} h-7 px-2 text-xs ${kind === k ? 'border-primary text-primary' : ''}`} onClick={() => setKind(k)}>
              {k === 'QUOTE' ? 'Quote' : k === 'INVOICE' ? 'Invoice' : 'Receipt'}
            </button>
          ))}
        </div>
        <DocPreview kind={kind} lang={props.lang} override={override} sources={props.sources} />
      </div>
    </div>
  );
}

// ─── simple settings forms ─────────────────────────────────────────────

export type SettingField =
  | { type: 'checkbox'; name: string; label: string; hint?: string }
  | { type: 'select'; name: string; label: string; options: { value: string; label: string }[]; hint?: string }
  | { type: 'text' | 'number'; name: string; label: string; hint?: string; placeholder?: string; mono?: boolean };

export function SettingsForm(props: {
  action: 'general' | 'vat' | 'numbering';
  title: string;
  sections: { title?: string; fields: SettingField[]; aside?: React.ReactNode }[];
  initial: Record<string, string | number | boolean>;
  historyKey: string;
}) {
  const [values, setValues] = useState(props.initial);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(props.initial);
  const run = async () => {
    const fn = props.action === 'general' ? saveGeneralSettings : props.action === 'vat' ? saveVatSettings : saveNumberingSettings;
    const r = await fn(values);
    setRes(r);
    if (r.ok) setTimeout(() => location.reload(), 600);
  };
  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-5">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{props.title}</h2>
      {props.sections.map((s, i) => (
        <div key={i} className="space-y-3">
          {s.title && <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{s.title}</h3>}
          {s.aside}
          <div className="grid gap-3 sm:grid-cols-2">
            {s.fields.map((f) => (
              <div key={f.name} className={f.type === 'checkbox' ? 'sm:col-span-2' : ''}>
                {f.type === 'checkbox' ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="accent-primary h-4 w-4 mt-0.5" checked={!!values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))} />
                    <span>
                      <span className="font-semibold">{f.label}</span>
                      {f.hint && <span className="block text-[11px] text-muted-foreground">{f.hint}</span>}
                    </span>
                  </label>
                ) : (
                  <label className="block text-sm font-semibold">
                    {f.label}
                    {f.type === 'select' ? (
                      <select className={`${inputCls} mt-1`} value={String(values[f.name] ?? '')} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={f.type}
                        className={`${inputCls} mt-1 ${'mono' in f && f.mono ? 'font-mono' : ''}`}
                        placeholder={'placeholder' in f ? f.placeholder : undefined}
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: f.type === 'number' ? e.target.value : e.target.value }))}
                      />
                    )}
                    {f.hint && <span className="block text-[11px] font-normal text-muted-foreground mt-1">{f.hint}</span>}
                  </label>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={btnPrimary} disabled={pending || !dirty} onClick={() => start(run)}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save</button>
        <button type="button" className={btnGhost} disabled={!dirty} onClick={() => setValues(props.initial)}>Discard changes</button>
        <button type="button" className={`${btnGhost} ml-auto`} onClick={() => { if (confirm('Go back to the built-in defaults? The current version stays in History.')) start(async () => { const r = await resetToDefault(props.historyKey); setRes(r); if (r.ok) location.reload(); }); }}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset to default
        </button>
      </div>
      <Status r={res} />
    </section>
  );
}

export function VatTester() {
  const [country, setCountry] = useState('DE');
  const [vatId, setVatId] = useState('');
  const [out, setOut] = useState<Awaited<ReturnType<typeof testVat>> | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Try the rules</h2>
      <p className="text-xs text-muted-foreground">Uses the saved rules and a live VIES check. Nothing is stored.</p>
      <div className="flex gap-2 flex-wrap">
        <input className={`${inputCls} w-24 uppercase`} maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} aria-label="Buyer country (two letters)" placeholder="NL" />
        <input className={`${inputCls} flex-1 min-w-[12rem] font-mono`} value={vatId} onChange={(e) => setVatId(e.target.value)} aria-label="Buyer VAT ID" placeholder="Buyer VAT ID, e.g. DE123456789" />
        <button type="button" className={btnGhost} disabled={pending} onClick={() => start(async () => setOut(await testVat(country, vatId)))}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Check</button>
      </div>
      {out && (
        <div className="rounded-lg border border-border p-3 text-sm space-y-1">
          {out.ok && out.decision ? (
            <>
              <p className="font-bold">{out.decision.treatment === 'DOMESTIC' ? `Standard VAT ${out.decision.rateBp / 100}%` : out.decision.treatment === 'REVERSE_CHARGE' ? 'EU reverse charge, 0%' : out.decision.treatment === 'EXPORT' ? 'Export, 0%' : 'Needs your decision'}{out.decision.blocked ? ' — blocked' : ''}</p>
              <p className="text-muted-foreground">{out.decision.reason}</p>
              {out.vies && <p className="text-xs text-muted-foreground">VIES: {out.vies.status}{out.vies.name ? ` · ${out.vies.name}` : ''}{out.vies.error ? ` · ${out.vies.error}` : ''}</p>}
            </>
          ) : (
            <p className="text-red-700">{out.message}</p>
          )}
        </div>
      )}
    </section>
  );
}

// ─── company & bank ────────────────────────────────────────────────────

export function CompanyForm(props: { fields: { key: string; label: string; hint: string; multiline?: boolean; group: string }[]; values: Record<string, string> }) {
  const [state, action, pending] = useActionState(saveCompanyDetails, null);
  // Controlled fields: React resets an uncontrolled form after its action, which
  // wiped everything typed when the server refused one field.
  const [vals, setVals] = useState(props.values);
  const set = (k: string, v: string) => setVals((x) => ({ ...x, [k]: v }));
  return (
    <form action={action} className="rounded-2xl border border-border bg-card p-5 space-y-5">
      {['Company', 'Bank'].map((g) => (
        <fieldset key={g} className="space-y-3">
          <legend className="text-sm font-bold uppercase tracking-[0.15em] text-primary mb-2">{g === 'Company' ? 'Company block' : 'Bank details'}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {props.fields.filter((f) => f.group === g).map((f) => (
              <label key={f.key} className={`block text-sm font-semibold ${f.multiline ? 'sm:col-span-2' : ''}`}>
                {f.label}
                {f.multiline ? (
                  <textarea name={f.key} rows={3} value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} className={`${areaCls} mt-1`} autoComplete="off" />
                ) : (
                  <input name={f.key} value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} className={`${inputCls} mt-1 ${/IBAN|SWIFT|VAT|KVK/.test(f.key) ? 'font-mono' : ''}`} autoComplete="off" data-1p-ignore data-lpignore="true" />
                )}
                <span className="block text-[11px] font-normal text-muted-foreground mt-1">{f.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button type="submit" className={btnPrimary} disabled={pending}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save company & bank</button>
      <Status r={state} />
    </form>
  );
}

// ─── e-mails ───────────────────────────────────────────────────────────

export function EmailEditor(props: {
  emailKey: string;
  label: string;
  when: string;
  canDisable: boolean;
  enabled: boolean;
  attachments?: string;
  hasButton: boolean;
  fields: Field[];
  initial: Record<string, { subject: string; body: string; button: string }>;
  me: string;
}) {
  const [lang, setLang] = useState<'en' | 'nl'>('en');
  const [all, setAll] = useState(props.initial);
  const [enabled, setEnabled] = useState(props.enabled);
  const [preview, setPreview] = useState<{ subject?: string; html?: string; message?: string; problems?: string[] } | null>(null);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [testTo, setTestTo] = useState(props.me);
  const [pending, start] = useTransition();
  const { onFocusCapture, insert } = useInsertTarget();
  const t = all[lang];
  const set = (name: string, value: string) => setAll((a) => ({ ...a, [lang]: { ...a[lang], [name]: value } }));
  const dirty = JSON.stringify(all[lang]) !== JSON.stringify(props.initial[lang]);
  const body = JSON.stringify(t);

  useEffect(() => {
    const h = setTimeout(async () => setPreview(await previewEmail(props.emailKey, lang, JSON.parse(body))), 500);
    return () => clearTimeout(h);
  }, [body, lang, props.emailKey]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="rounded-2xl border border-border bg-card p-5 space-y-4 min-w-0" onFocusCapture={onFocusCapture}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-bold">{props.label}</h2>
            <p className="text-xs text-muted-foreground">{props.when}{props.attachments ? ` Attached: ${props.attachments}.` : ''}</p>
          </div>
          <div className="flex items-center gap-1">
            {(['en', 'nl'] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)} className={`${btnGhost} h-8 px-3 ${lang === l ? 'border-primary text-primary' : ''}`}>{l === 'en' ? 'English' : 'Dutch'}</button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary h-4 w-4"
            checked={enabled}
            disabled={!props.canDisable || pending}
            onChange={(e) => {
              const v = e.target.checked;
              start(async () => {
                const r = await setEmailEnabled(props.emailKey, v);
                setRes(r);
                if (r.ok) setEnabled(v);
              });
            }}
          />
          {props.canDisable ? 'Send this e-mail' : 'Always sent (security or a document the recipient needs)'}
        </label>
        <div className="flex justify-end">
          <InsertField fields={props.fields} onPick={(f) => { if (!insert(`{{${f.name}}}`, set)) setRes({ ok: false, message: 'Click into the subject or body first, then insert the field.' }); }} />
        </div>
        <label className="block text-sm font-semibold">Subject
          <input name="subject" type="text" className={`${inputCls} mt-1`} value={t.subject} onChange={(e) => set('subject', e.target.value)} />
        </label>
        <label className="block text-sm font-semibold">Body
          <textarea name="body" rows={12} className={`${areaCls} mt-1`} value={t.body} onChange={(e) => set('body', e.target.value)} />
        </label>
        {props.hasButton && (
          <label className="block text-sm font-semibold">Button label <span className="font-normal text-muted-foreground">(the link is set by the site; leave empty for no button)</span>
            <input name="button" type="text" className={`${inputCls} mt-1`} value={t.button} onChange={(e) => set('button', e.target.value)} />
          </label>
        )}
        <FormatHelp />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className={btnPrimary} disabled={pending || !dirty} onClick={() => start(async () => setRes(await saveEmailTexts(props.emailKey, lang, t)))}>Save {lang === 'en' ? 'English' : 'Dutch'}</button>
          <button type="button" className={btnGhost} disabled={!dirty} onClick={() => setAll((a) => ({ ...a, [lang]: props.initial[lang] }))}>Discard changes</button>
          <button type="button" className={`${btnGhost} ml-auto`} onClick={() => { if (confirm('Replace this e-mail with the built-in text? The current version stays in History.')) start(async () => { const r = await resetToDefault(`email:${props.emailKey}:${lang}`); setRes(r); if (r.ok) location.reload(); }); }}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
        </div>
        <Status r={res} />
      </section>
      <section className="rounded-2xl border border-border bg-card p-3 space-y-3 lg:sticky lg:top-4 min-w-0">
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> Preview with example values</p>
        {preview?.subject && <p className="text-sm"><span className="text-muted-foreground">Subject:</span> <strong>{preview.subject}</strong></p>}
        {preview && !preview.html && preview.problems && <Status r={{ ok: false, message: preview.message || 'Cannot preview yet:', problems: preview.problems }} />}
        <iframe title="E-mail preview" sandbox="" srcDoc={preview?.html ?? ''} className="w-full rounded-lg border border-border bg-[#f4f5f7]" style={{ height: 560 }} />
        <div className="flex items-center gap-2 flex-wrap border-t border-border pt-3">
          <input className={`${inputCls} h-8 flex-1 min-w-[12rem]`} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Send a test to" />
          <button type="button" className={`${btnGhost} h-8`} disabled={pending} onClick={() => start(async () => setRes(await sendTestEmail(props.emailKey, lang, t, testTo)))}>
            <Send className="h-3.5 w-3.5" /> Send test
          </button>
        </div>
      </section>
    </div>
  );
}

export function EmailFooterEditor({ initial }: { initial: Record<'en' | 'nl', string> }) {
  const [v, setV] = useState(initial);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Footer of every e-mail</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['en', 'nl'] as const).map((l) => (
          <label key={l} className="block text-sm font-semibold">{l === 'en' ? 'English' : 'Dutch'}
            <textarea rows={3} className={`${areaCls} mt-1`} value={v[l]} onChange={(e) => setV((x) => ({ ...x, [l]: e.target.value }))} />
            <button type="button" className={`${btnGhost} h-8 mt-2`} disabled={pending || v[l] === initial[l]} onClick={() => start(async () => setRes(await saveEmailLayout(l, { footer: v[l] })))}>Save {l.toUpperCase()}</button>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">Fields: {'{{company.name}}'}, {'{{site.url}}'}, {'{{support.email}}'}, {'{{site.name}}'}.</p>
      <Status r={res} />
    </section>
  );
}

// ─── history ───────────────────────────────────────────────────────────

export function HistoryPanel({ keys, initialKey }: { keys: { key: string; label: string }[]; initialKey?: string }) {
  const [key, setKey] = useState(initialKey ?? keys[0]?.key ?? '');
  const [data, setData] = useState<Awaited<ReturnType<typeof versionsOf>> | null>(null);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!key) return;
    let live = true;
    versionsOf(key).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [key, res]);
  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <History className="h-4 w-4 text-primary" />
        <label htmlFor="hist-key" className="text-sm font-semibold">History of</label>
        <select id="hist-key" className={`${inputCls} w-auto max-w-full`} value={key} onChange={(e) => setKey(e.target.value)}>
          {keys.map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
      </div>
      <Status r={res} />
      {!data ? (
        <p className="text-sm text-muted-foreground inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : !data.ok ? (
        <p className="text-sm text-red-700">{data.message}</p>
      ) : data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Never changed — the built-in defaults are in use.</p>
      ) : (
        <ol className="space-y-3">
          {data.rows.map((r, i) => (
            <li key={r.version} className="rounded-xl border border-border p-3">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-bold">Version {r.version}</span>
                {i === 0 && <span className="text-[10px] font-bold uppercase tracking-wider rounded bg-emerald-100 text-emerald-800 px-1.5 py-0.5 dark:bg-emerald-900/40 dark:text-emerald-300">current</span>}
                <span className="text-muted-foreground">{new Date(r.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span className="text-muted-foreground">· {r.by ?? 'system'}</span>
                {r.note && <span className="text-muted-foreground">· {r.note}</span>}
                {i > 0 && (
                  <button type="button" className={`${btnGhost} h-7 px-2 text-xs ml-auto`} disabled={pending} onClick={() => { if (confirm(`Restore version ${r.version}? This creates a new version; nothing is lost.`)) start(async () => setRes(await restoreVersion(key, r.version))); }}>
                    <RotateCcw className="h-3.5 w-3.5" /> Restore this version
                  </button>
                )}
              </div>
              {r.changes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {r.changes.map((c) => (
                    <li key={c.path} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
                      <span className="font-mono text-muted-foreground break-all">{c.path || '(all)'}</span>
                      <span className="min-w-0">
                        {c.before && <del className="block bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200 rounded px-1 whitespace-pre-wrap break-words">{c.before}</del>}
                        <ins className="block no-underline bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200 rounded px-1 whitespace-pre-wrap break-words">{c.after || '(empty)'}</ins>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
