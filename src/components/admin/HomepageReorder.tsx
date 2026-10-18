'use client';

import { useState } from 'react';
import { GripVertical, Eye, EyeOff, ArrowUp, ArrowDown } from 'lucide-react';

export type ModuleRow = { key: string; label: string; enabled: boolean };

/**
 * Ordered on/off list (Admin → Homepage): drag a row, or use the arrows, to
 * order it; the pill shows or hides it. The shown keys, in order, are posted
 * comma-separated as `name` (e.g. HOME_EXTRAS). `pinned` keys stay at the top.
 * At least `minShown` rows stay shown.
 */
export function HomepageReorder({
  initial,
  name,
  pinned = [],
  minShown = 0,
  renderExtra,
}: {
  initial: ModuleRow[];
  name: string;
  pinned?: string[];
  minShown?: number;
  /** Extra controls in a row (e.g. the station's rail label). */
  renderExtra?: (row: ModuleRow) => React.ReactNode;
}) {
  const [items, setItems] = useState<ModuleRow[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const isPinned = (k: string) => pinned.includes(k);

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= items.length) return;
    if (isPinned(items[from].key) || isPinned(items[to].key)) return;
    setItems((arr) => {
      const next = arr.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  }

  function toggle(idx: number) {
    const shown = items.filter((it) => it.enabled).length;
    if (items[idx].enabled && shown <= minShown) return;
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, enabled: !it.enabled } : it)));
  }

  return (
    <>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card overflow-hidden">
        {items.map((it, i) => (
          <li
            key={it.key}
            draggable={!isPinned(it.key)}
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(i));
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOverIdx(i);
            }}
            onDragLeave={() => setOverIdx(null)}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (!Number.isNaN(from)) move(from, i);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
            className={`p-3 flex items-center gap-3 flex-wrap transition-colors ${isPinned(it.key) ? '' : 'cursor-move'} ${
              dragIdx === i ? 'opacity-50 bg-primary/10' : ''
            } ${overIdx === i && dragIdx !== i ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}
          >
            <GripVertical className={`h-4 w-4 flex-shrink-0 ${isPinned(it.key) ? 'text-transparent' : 'text-muted-foreground'}`} />
            <span className="text-[10px] font-mono w-6 text-center rounded bg-foreground/5 px-1.5 py-0.5 tabular-nums">
              {i + 1}
            </span>
            <span className={`flex-1 min-w-[10rem] text-sm font-medium ${it.enabled ? '' : 'text-muted-foreground line-through'}`}>
              {it.label}
              {isPinned(it.key) && <span className="ml-2 text-[10px] font-normal text-muted-foreground no-underline">(always first)</span>}
            </span>
            {renderExtra?.(it)}
            <span className="inline-flex items-center gap-1">
              <button type="button" onClick={() => move(i, i - 1)} disabled={isPinned(it.key) || i === 0 || isPinned(items[i - 1]?.key ?? '')} aria-label={`Move ${it.label} up`} className="h-8 w-8 inline-grid place-items-center rounded-full border border-border hover:bg-foreground/5 disabled:opacity-30">
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => move(i, i + 1)} disabled={isPinned(it.key) || i === items.length - 1} aria-label={`Move ${it.label} down`} className="h-8 w-8 inline-grid place-items-center rounded-full border border-border hover:bg-foreground/5 disabled:opacity-30">
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </span>
            <button
              type="button"
              onClick={() => toggle(i)}
              aria-pressed={it.enabled}
              className={`inline-flex items-center gap-1.5 text-xs px-3 h-8 rounded-full font-semibold border ${
                it.enabled
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-900/40'
                  : 'bg-foreground/5 text-muted-foreground border-border hover:bg-foreground/10'
              }`}
              aria-label={it.enabled ? `Hide ${it.label} on the homepage` : `Show ${it.label} on the homepage`}
            >
              {it.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {it.enabled ? 'shown' : 'hidden'}
            </button>
          </li>
        ))}
      </ul>
      <input type="hidden" name={name} value={items.filter((it) => it.enabled).map((it) => it.key).join(',')} />
    </>
  );
}

/**
 * The preview next to the editor: the saved draft (/?homepreview=<token>) while
 * one exists, else the live homepage. It reloads whenever a new draft is saved.
 */
export function HomepagePreview({ token, version }: { token: string | null; version: string }) {
  const [nonce, setNonce] = useState(0);
  const src = token ? `/?homepreview=${encodeURIComponent(token)}` : '/';
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-foreground/[0.03]">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {token ? 'Draft preview' : 'Live homepage'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="text-[11px] font-semibold px-3 h-7 rounded-full border border-border bg-card hover:bg-foreground/5"
          >
            ↻ Refresh
          </button>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-semibold px-3 h-7 rounded-full bg-primary text-primary-foreground inline-flex items-center"
          >
            Open in new tab ↗
          </a>
        </div>
      </div>
      <iframe
        key={`${version}:${nonce}`}
        src={`${src}${token ? '&' : '?'}_=${encodeURIComponent(version)}-${nonce}`}
        title={token ? 'Homepage draft preview' : 'Homepage preview'}
        className="w-full h-[600px] bg-card"
      />
      <p className="text-[10px] text-muted-foreground p-2.5 border-t border-border">
        {token
          ? 'Shows the saved draft — not what visitors see. “Save draft” updates it; “Publish” makes it live.'
          : 'No draft: this is the live homepage. “Save draft” to preview changes before publishing them.'}
      </p>
    </div>
  );
}
