'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteSupplier, saveSupplier } from '@/app/admin/inventory/actions';

type S = { id: string; name: string; contactName: string; email: string; phone: string; website: string; notes: string; items: number };
const EMPTY: Omit<S, 'id' | 'items'> = { name: '', contactName: '', email: '', phone: '', website: '', notes: '' };

export function SupplierManager({ suppliers, canEdit }: { suppliers: S[]; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<(Omit<S, 'items' | 'id'> & { id?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      const r = await saveSupplier(editing);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setEditing(null);
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: 'Could not reach the server.' });
    }
    setBusy(false);
  };
  const remove = async (s: S) => {
    if (!window.confirm(`Delete supplier "${s.name}"?${s.items ? ` ${s.items} item${s.items === 1 ? '' : 's'} will keep their data but lose the supplier.` : ''}`)) return;
    const r = await deleteSupplier(s.id);
    setMsg({ ok: r.ok, text: r.message });
    router.refresh();
  };
  const input = 'mt-1 w-full h-9 rounded-lg border border-border bg-background px-3 text-sm';

  return (
    <div className="space-y-4">
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-red-500/10 text-red-700 dark:text-red-300'}`}>
          {msg.text}
        </p>
      )}
      {canEdit && !editing && (
        <button type="button" onClick={() => setEditing({ ...EMPTY })} className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Add supplier
        </button>
      )}
      {editing && (
        <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-5 grid sm:grid-cols-2 gap-3" aria-label="Supplier">
          <label className="text-sm font-medium sm:col-span-2">Name<input required maxLength={120} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={input} /></label>
          <label className="text-sm font-medium">Contact person<input maxLength={120} value={editing.contactName} onChange={(e) => setEditing({ ...editing, contactName: e.target.value })} className={input} /></label>
          <label className="text-sm font-medium">E-mail<input type="email" maxLength={200} value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className={input} /></label>
          <label className="text-sm font-medium">Phone<input maxLength={60} value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} className={input} /></label>
          <label className="text-sm font-medium">Website<input maxLength={300} value={editing.website} onChange={(e) => setEditing({ ...editing, website: e.target.value })} className={input} /></label>
          <label className="text-sm font-medium sm:col-span-2">Notes<textarea maxLength={2000} rows={3} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} className={`${input} h-auto py-2`} /></label>
          <div className="sm:col-span-2 flex gap-2 justify-end">
            <button type="button" onClick={() => setEditing(null)} className="h-9 px-4 rounded-full border border-border text-sm font-semibold">Cancel</button>
            <button type="submit" disabled={busy} className="h-9 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </form>
      )}
      <div className="rounded-2xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2">Supplier</th>
              <th className="text-left px-4 py-2">Contact</th>
              <th className="text-left px-4 py-2">Notes</th>
              <th className="text-right px-4 py-2">Items</th>
              <th className="px-4 py-2 w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2.5 font-semibold">
                  {s.name}
                  {s.website && (
                    <a href={/^https?:\/\//.test(s.website) ? s.website : `https://${s.website}`} target="_blank" rel="noreferrer noopener" className="block text-xs font-normal text-primary hover:underline truncate max-w-[240px]">
                      {s.website}
                    </a>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{[s.contactName, s.email, s.phone].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 text-muted-foreground max-w-[280px] truncate" title={s.notes}>{s.notes || '—'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <a href={`/admin/inventory?q=${encodeURIComponent(s.name)}`} className="hover:underline">{s.items}</a>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {canEdit && (
                    <>
                      <button type="button" onClick={() => setEditing({ id: s.id, name: s.name, contactName: s.contactName, email: s.email, phone: s.phone, website: s.website, notes: s.notes })} className="p-1.5 rounded hover:bg-muted" aria-label={`Edit ${s.name}`}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => remove(s)} className="p-1.5 rounded hover:bg-muted text-red-600" aria-label={`Delete ${s.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No suppliers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
