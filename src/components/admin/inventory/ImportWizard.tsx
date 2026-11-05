'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { applyImport, previewImport } from '@/app/admin/inventory/import/actions';
import type { ApplyLineResult, Preview, PreviewLine, PreviewStatus, Target } from '@/lib/inventory/import';

const STATUS: Record<PreviewStatus, { label: string; tone: string }> = {
  update: { label: 'Change', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  new: { label: 'New item', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  conflict: { label: 'Conflict', tone: 'bg-amber-500/20 text-amber-800 dark:text-amber-300' },
  error: { label: 'Error', tone: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  unchanged: { label: 'No change', tone: 'bg-foreground/5 text-muted-foreground' },
  skipped: { label: 'Skipped', tone: 'bg-foreground/5 text-muted-foreground' },
};

export function ImportWizard({ targets }: { targets: { value: Target; label: string }[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Target[]>([]);
  const [useFile, setUseFile] = useState<Set<number>>(new Set());
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [show, setShow] = useState<'changes' | 'all'>('changes');
  const [result, setResult] = useState<{ message: string; ok: boolean; results: ApplyLineResult[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const check = async (f: File | null = file, map: Target[] | null = null) => {
    if (!f) {
      setError('Choose an .xlsx or .csv file first.');
      return;
    }
    setBusy('check');
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.set('file', f);
    if (map) fd.set('mapping', JSON.stringify(map));
    try {
      const res = await previewImport(fd);
      if (!res.ok) {
        setError(res.message);
        setPreview(null);
      } else {
        setPreview(res.preview);
        setMapping(res.preview.mapping);
        setUseFile(new Set());
        setSkip(new Set());
      }
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    }
    setBusy(null);
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    setError(null);
    try {
      const res = await applyImport(preview.id, { useFileForConflicts: [...useFile], skipLines: [...skip] });
      setResult(res);
      if (res.results.length || res.ok) setPreview(null);
      else setError(res.message);
    } catch {
      setError('Could not reach the server. Check the inventory before trying again.');
    }
    setBusy(null);
  };

  const lines = useMemo(
    () => (preview ? preview.lines.filter((l) => show === 'all' || ['update', 'new', 'conflict', 'error'].includes(l.status)) : []),
    [preview, show],
  );
  const toApply = preview ? preview.lines.filter((l) => ['update', 'new', 'conflict'].includes(l.status) && !skip.has(l.line)) : [];
  const nUpdate = toApply.filter((l) => l.status === 'update' || (l.status === 'conflict' && useFile.has(l.line))).length;
  const nNew = toApply.filter((l) => l.status === 'new').length;
  const nConflictKept = toApply.filter((l) => l.status === 'conflict' && !useFile.has(l.line)).length;

  if (result) {
    return (
      <div className="space-y-4" data-testid="import-result">
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${result.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
          {result.ok ? <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" /> : <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />}
          <div>
            <p className="font-semibold">{result.message}</p>
            <p className="text-sm text-muted-foreground mt-1">Every change is in each item&apos;s history (source: import). The site shows the new values already.</p>
          </div>
        </div>
        <ul className="rounded-xl border border-border bg-card divide-y divide-border text-sm">
          {result.results.map((r) => (
            <li key={r.line} className="px-4 py-2.5 flex gap-3">
              <span className="text-muted-foreground tabular-nums w-14 shrink-0">Line {r.line}</span>
              <span className="font-medium flex-1 min-w-0 truncate">{r.title}</span>
              <span className={r.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}>{r.message}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Link href="/admin/inventory" className="h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2">
            Back to the inventory <ArrowRight className="h-4 w-4" />
          </Link>
          <button type="button" onClick={() => { setResult(null); setFile(null); if (input.current) input.current.value = ''; }} className="h-10 px-4 rounded-full border border-border text-sm font-semibold">
            Import another file
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div
        className="rounded-2xl border-2 border-dashed border-border bg-card p-6 flex flex-col sm:flex-row sm:items-center gap-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) {
            setFile(f);
            void check(f);
          }
        }}
      >
        <FileSpreadsheet className="h-10 w-10 text-primary shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">{file ? file.name : 'Choose or drop an .xlsx or .csv file'}</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Best: <Link href="/admin/inventory" className="underline">export to Excel</Link>, edit, and bring it back here. Other spreadsheets work too: columns are matched by their names, and you can correct the matching below.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label="Spreadsheet file"
          className="text-sm max-w-[240px]"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setPreview(null);
            if (f) void check(f);
          }}
        />
        <button type="button" onClick={() => check()} disabled={!file || busy !== null} className="h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
          {busy === 'check' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Check file
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {preview && (
        <>
          <details className="rounded-xl border border-border bg-card" open={preview.lines.every((l) => l.status === 'new' || l.status === 'error')}>
            <summary className="px-4 py-3 cursor-pointer font-semibold text-sm">Columns: how the file is read ({preview.headers.length})</summary>
            <div className="px-4 pb-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {preview.headers.map((h, i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-40 truncate font-mono text-xs bg-muted rounded px-2 py-1" title={h}>{h || `(column ${i + 1})`}</span>
                  <span className="text-muted-foreground">→</span>
                  <select
                    value={mapping[i] ?? 'ignore'}
                    onChange={(e) => {
                      const next = [...mapping];
                      next[i] = e.target.value as Target;
                      setMapping(next);
                    }}
                    className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                    aria-label={`Column ${h} imports as`}
                  >
                    {targets.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              ))}
              <div className="sm:col-span-2 lg:col-span-3">
                <button type="button" onClick={() => check(file, mapping)} disabled={busy !== null} className="h-8 px-3 rounded-md border border-border text-sm font-semibold hover:bg-muted">
                  Check again with these columns
                </button>
              </div>
            </div>
          </details>

          {preview.warnings.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {preview.warnings.map((w, i) => (
                <li key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />{w}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2" data-testid="import-counts">
            {(Object.keys(STATUS) as PreviewStatus[]).map((k) => (
              <span key={k} className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS[k].tone}`}>
                {preview.counts[k]} {STATUS[k].label.toLowerCase()}
                {k === 'update' || k === 'new' ? (preview.counts[k] === 1 ? '' : 's') : ''}
              </span>
            ))}
            <div className="ml-auto flex rounded-full border border-border p-0.5 text-xs font-semibold">
              <button type="button" onClick={() => setShow('changes')} className={`px-3 py-1 rounded-full ${show === 'changes' ? 'bg-foreground text-background' : ''}`}>Lines with changes</button>
              <button type="button" onClick={() => setShow('all')} className={`px-3 py-1 rounded-full ${show === 'all' ? 'bg-foreground text-background' : ''}`}>All lines</button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-x-auto" data-testid="import-preview">
            <table className="w-full text-sm">
              <thead className="bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 w-16">Line</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-left px-3 py-2 w-28">Result</th>
                  <th className="text-left px-3 py-2">Before → after</th>
                  <th className="text-left px-3 py-2 w-48">Apply?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((l) => (
                  <PreviewRow
                    key={l.line}
                    l={l}
                    skipped={skip.has(l.line)}
                    useFile={useFile.has(l.line)}
                    onSkip={(v) => setSkip((s) => { const n = new Set(s); if (v) n.add(l.line); else n.delete(l.line); return n; })}
                    onUseFile={(v) => setUseFile((s) => { const n = new Set(s); if (v) n.add(l.line); else n.delete(l.line); return n; })}
                  />
                ))}
                {lines.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">Nothing would change: the file matches the inventory.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
            <p className="text-sm">
              <b>{nUpdate}</b> item{nUpdate === 1 ? '' : 's'} will change, <b>{nNew}</b> new listing{nNew === 1 ? '' : 's'}
              {nConflictKept > 0 && <> · {nConflictKept} conflict{nConflictKept === 1 ? '' : 's'} keep the site value</>}
              {preview.counts.error > 0 && <> · {preview.counts.error} line{preview.counts.error === 1 ? '' : 's'} with errors are not imported</>}
            </p>
            <button
              type="button"
              onClick={apply}
              disabled={busy !== null || nUpdate + nNew === 0}
              className="ml-auto h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
              data-testid="import-apply"
            >
              {busy === 'apply' && <Loader2 className="h-4 w-4 animate-spin" />} Apply {nUpdate + nNew} line{nUpdate + nNew === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PreviewRow({ l, skipped, useFile, onSkip, onUseFile }: { l: PreviewLine; skipped: boolean; useFile: boolean; onSkip: (v: boolean) => void; onUseFile: (v: boolean) => void }) {
  const st = STATUS[l.status];
  const actionable = l.status === 'update' || l.status === 'new' || l.status === 'conflict';
  return (
    <tr className={skipped ? 'opacity-50' : ''} data-line={l.line} data-status={l.status}>
      <td className="px-3 py-2.5 align-top tabular-nums text-muted-foreground">{l.line}</td>
      <td className="px-3 py-2.5 align-top">
        <p className="font-medium leading-snug">{l.title}</p>
        <p className="text-xs text-muted-foreground">
          {l.match ? `${l.match.sku ? `${l.match.sku} · ` : ''}matched by ${l.match.by}` : l.status === 'new' ? 'no match: new item' : ''}
        </p>
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.tone}`}>{st.label}</span>
      </td>
      <td className="px-3 py-2.5 align-top">
        {l.errors.map((e, i) => (
          <p key={i} className="text-red-600 dark:text-red-400">{e}</p>
        ))}
        <ul className="space-y-0.5">
          {l.changes.map((c, i) => (
            <li key={i}>
              <span className="text-muted-foreground">{c.label}:</span>{' '}
              {!l.match ? (
                <b>{c.to || 'empty'}</b>
              ) : (
                <>
                  <span className="line-through text-muted-foreground">{c.from || 'empty'}</span> → <b>{c.to || 'empty'}</b>
                </>
              )}
              {c.conflict && (
                <span className="block text-xs text-amber-700 dark:text-amber-300">
                  Changed on the site since the export too: it was {c.conflict.exported || 'empty'}, the site now has {c.conflict.site || 'empty'}.
                </span>
              )}
            </li>
          ))}
        </ul>
        {l.notes.map((n, i) => (
          <p key={i} className="text-xs text-muted-foreground mt-1">{n}</p>
        ))}
      </td>
      <td className="px-3 py-2.5 align-top text-xs">
        {actionable && (
          <div className="space-y-1.5">
            {l.status === 'conflict' && (
              <>
                <label className="flex items-center gap-1.5"><input type="radio" name={`c${l.line}`} checked={!useFile} onChange={() => onUseFile(false)} /> Keep the site value</label>
                <label className="flex items-center gap-1.5"><input type="radio" name={`c${l.line}`} checked={useFile} onChange={() => onUseFile(true)} /> Use the file value</label>
              </>
            )}
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={skipped} onChange={(e) => onSkip(e.target.checked)} /> Skip this line</label>
          </div>
        )}
      </td>
    </tr>
  );
}
