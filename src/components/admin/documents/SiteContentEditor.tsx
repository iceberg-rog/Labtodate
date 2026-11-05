'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { resetSiteGroup, saveSiteGroup, type SiteActionResult } from '@/app/admin/content/actions';
import type { SiteTextDef } from '@/lib/site/types';
import { areaCls, inputCls, type Field } from './DocumentsUI';

/** One content group (claims, a page, the menu): fields, Insert field, save, reset. */
export function SiteContentEditor(props: { groupId: string; title: string; description?: string; page?: string; fields: SiteTextDef[]; initial: Record<string, string>; vars: Field[] }) {
  const [values, setValues] = useState(props.initial);
  const [res, setRes] = useState<SiteActionResult | null>(null);
  const [pending, start] = useTransition();
  const [focus, setFocus] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [pick, setPick] = useState('');
  const dirty = JSON.stringify(values) !== JSON.stringify(props.initial);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  function insert(name: string) {
    if (!focus) {
      setRes({ ok: false, message: 'Click into a text box first, then insert the field.' });
      return;
    }
    const start = focus.selectionStart ?? focus.value.length;
    const end = focus.selectionEnd ?? focus.value.length;
    const text = `{{${name}}}`;
    set(focus.name, focus.value.slice(0, start) + text + focus.value.slice(end));
    requestAnimationFrame(() => {
      focus.focus();
      focus.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold">{props.title}</h2>
          {props.description && <p className="text-xs text-muted-foreground max-w-2xl">{props.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {props.page && (
            <a href={props.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> Open page
            </a>
          )}
          <select className={`${inputCls} h-8 w-48 text-xs`} value={pick} onChange={(e) => { if (e.target.value) insert(e.target.value); setPick(''); }} onMouseDown={(e) => e.stopPropagation()} aria-label="Insert field">
            <option value="">Insert field…</option>
            {props.vars.map((v) => (
              <option key={v.name} value={v.name}>{v.label} — e.g. {v.example}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-4">
        {props.fields.map((f) => (
          <div key={f.key}>
            {f.kind === 'toggle' ? (
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" className="accent-primary h-4 w-4" checked={values[f.key] !== 'off'} onChange={(e) => set(f.key, e.target.checked ? 'on' : 'off')} />
                {f.label}
              </label>
            ) : (
              <label className="block text-sm font-semibold">
                {f.label}
                {f.kind === 'select' ? (
                  <select className={`${inputCls} mt-1`} value={values[f.key] ?? f.default} onChange={(e) => set(f.key, e.target.value)}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : f.kind === 'rich' || f.kind === 'page' ? (
                  <textarea
                    name={f.key}
                    rows={f.kind === 'page' ? 22 : 4}
                    className={`${areaCls} mt-1 ${f.kind === 'page' ? 'font-mono text-[13px]' : ''}`}
                    value={values[f.key] ?? ''}
                    onFocus={(e) => setFocus(e.currentTarget)}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : (
                  <input
                    name={f.key}
                    type={f.kind === 'number' ? 'number' : 'text'}
                    min={f.min}
                    max={f.maxValue}
                    className={`${inputCls} mt-1`}
                    value={values[f.key] ?? ''}
                    onFocus={(e) => setFocus(e.currentTarget)}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </label>
            )}
            {f.hint && <p className="text-[11px] text-muted-foreground mt-1">{f.hint}</p>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Format: <code>**bold**</code> · lines starting with <code>- </code> are bullets · empty line = new paragraph{props.fields.some((f) => f.kind === 'page') ? <> · <code>## Heading</code> starts a section</> : null} · <code>[label](/page)</code> is a link (a page of this site, <code>mailto:</code> or <code>https://</code>) · fields like <code>{'{{company.name}}'}</code>. HTML is shown as plain text.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" disabled={pending || !dirty} onClick={() => start(async () => setRes(await saveSiteGroup(props.groupId, values)))} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
        </button>
        <button type="button" disabled={!dirty} onClick={() => setValues(props.initial)} className="inline-flex items-center h-9 px-4 rounded-lg text-sm font-semibold border border-border hover:bg-foreground/[0.04] disabled:opacity-50">Discard changes</button>
        <button
          type="button"
          onClick={() => { if (confirm('Go back to the built-in texts for this group? The current version stays in History.')) start(async () => { const r = await resetSiteGroup(props.groupId); setRes(r); if (r.ok) location.reload(); }); }}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-semibold border border-border hover:bg-foreground/[0.04] ml-auto"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset to default
        </button>
      </div>
      {res && (
        <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${res.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'}`}>
          <p className="font-semibold inline-flex items-center gap-1.5">{res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {res.message}</p>
          {res.problems && <ul className="mt-1 list-disc pl-5">{res.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
