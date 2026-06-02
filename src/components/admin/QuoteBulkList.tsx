'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Trash2, X, CheckSquare, Square } from 'lucide-react';
import { QuoteRow, type QuoteRowProps } from './QuoteRow';
import { bulkArchiveQuotes, bulkUnarchiveQuotes, bulkDeleteQuotes } from '@/lib/quotes/actions';

export function QuoteBulkList({
  rows,
  view,
  canDelete,
}: {
  rows: QuoteRowProps[];
  view: 'active' | 'archived';
  canDelete: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => allSelected ? setSelected(new Set()) : setSelected(new Set(rows.map((r) => r.id)));
  const clear = () => setSelected(new Set());

  function run(action: (fd: FormData) => Promise<{ ok: boolean; count: number; message: string }>) {
    setMsg(null);
    const ids = Array.from(selected);
    start(async () => {
      const fd = new FormData(); fd.set('ids', ids.join(','));
      try {
        const r = await action(fd);
        setMsg(r.message);
        if (r.ok) clear();
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Action failed.');
      }
    });
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="sticky top-0 z-30 flex items-center gap-2 flex-wrap rounded-2xl border-2 border-primary/40 bg-primary/[0.06] backdrop-blur px-4 py-2.5 shadow-sm">
          <button type="button" onClick={selectAll} className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline">
            {allSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-bold">{`${selected.size} selected`}</span>
          <span className="flex-1" />

          {view === 'active' && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(bulkArchiveQuotes)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border bg-card text-xs font-bold hover:bg-foreground/5 disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" /> Archive {selected.size}
            </button>
          )}

          {view === 'archived' && (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(bulkUnarchiveQuotes)}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border bg-card text-xs font-bold hover:bg-foreground/5 disabled:opacity-50"
              >
                <ArchiveRestore className="h-3.5 w-3.5" /> Restore {selected.size}
              </button>
              {canDelete && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Permanently delete ${selected.size} quote${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
                    run(bulkDeleteQuotes);
                  }}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border-2 border-red-300 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete {selected.size}
                </button>
              )}
            </>
          )}

          <button type="button" onClick={clear} className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-foreground/10" aria-label="Clear selection">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {msg && <p className="text-xs text-emerald-700 font-semibold px-1">{msg}</p>}

      <ul className="space-y-3">
        {rows.map((r) => (
          <QuoteRow
            key={r.id}
            {...r}
            selectable
            selected={selected.has(r.id)}
            onSelectToggle={() => toggle(r.id)}
          />
        ))}
      </ul>
    </div>
  );
}
