'use client';

import { useState } from 'react';
import { GripVertical, Eye, EyeOff } from 'lucide-react';

export type ModuleRow = { key: string; label: string; enabled: boolean };

export function HomepageReorder({ initial }: { initial: ModuleRow[] }) {
  const [items, setItems] = useState<ModuleRow[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  function move(from: number, to: number) {
    if (from === to) return;
    setItems((arr) => {
      const next = arr.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
  }

  function toggle(idx: number) {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, enabled: !it.enabled } : it)));
  }

  return (
    <>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card overflow-hidden">
        {items.map((it, i) => (
          <li
            key={it.key}
            draggable
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
            className={`p-4 flex items-center gap-3 cursor-move transition-colors ${
              dragIdx === i ? 'opacity-50 bg-primary/10' : ''
            } ${overIdx === i && dragIdx !== i ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}
          >
            <GripVertical className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-[10px] font-mono w-6 text-center rounded bg-foreground/5 px-1.5 py-0.5 tabular-nums">
              {i + 1}
            </span>
            <span className={`flex-1 text-sm font-medium ${it.enabled ? '' : 'text-muted-foreground line-through'}`}>
              {it.label}
            </span>
            <button
              type="button"
              onClick={() => toggle(i)}
              className={`inline-flex items-center gap-1.5 text-xs px-3 h-8 rounded-full font-semibold border ${
                it.enabled
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-foreground/5 text-muted-foreground border-border hover:bg-foreground/10'
              }`}
              aria-label={it.enabled ? 'Hide on homepage' : 'Show on homepage'}
            >
              {it.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {it.enabled ? 'shown' : 'hidden'}
            </button>
          </li>
        ))}
      </ul>
      {/* Hidden inputs the saveHomepage server action reads — order comes from
          position in the list, enabled from the toggle state. */}
      {items.map((it, i) => (
        <span key={it.key}>
          <input type="hidden" name={`order_${it.key}`} value={i + 1} />
          {it.enabled && <input type="hidden" name={`enabled_${it.key}`} value="on" />}
        </span>
      ))}
      <p className="text-[11px] text-muted-foreground">
        Drag rows to reorder. Click the badge on the right to show or hide a module.
      </p>
    </>
  );
}

export function HomepagePreview() {
  // Reload-on-demand iframe of the live homepage. Cache-busted via a key state
  // so saving + clicking "Refresh" shows the new content.
  const [nonce, setNonce] = useState(() => Date.now());
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-foreground/[0.03]">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Live preview
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNonce(Date.now())}
            className="text-[11px] font-semibold px-3 h-7 rounded-full border border-border bg-card hover:bg-foreground/5"
          >
            ↻ Refresh
          </button>
          <a
            href="/"
            target="_blank"
            className="text-[11px] font-semibold px-3 h-7 rounded-full bg-primary text-primary-foreground inline-flex items-center"
          >
            Open in new tab ↗
          </a>
        </div>
      </div>
      <iframe
        key={nonce}
        src={`/?adminpreview=1&_=${nonce}`}
        title="Homepage preview"
        className="w-full h-[600px] bg-white"
      />
      <p className="text-[10px] text-muted-foreground p-2.5 border-t border-border">
        Refresh after “Save homepage” to see your reorder + content updates immediately.
      </p>
    </div>
  );
}
