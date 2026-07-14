'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, ShieldOff, X, Loader2 } from 'lucide-react';
import type { UserRole } from '@prisma/client';
import { Badge } from '@/components/ui/badge';
import { UserQuickTrigger } from '@/components/admin/UserQuickView';
import { RoleSelect } from '@/app/admin/users/RoleSelect';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'admin',
  BUYER: 'buyer',
  SELLER: 'internal supplier',
};

export type UserRow = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  role: UserRole;
  joinedLabel: string;
};

type BulkResult = { ok: boolean; count: number; message: string };

/**
 * Users table with row selection + bulk suspend/delete straight from the list.
 * Checkboxes + the bulk bar only appear for admins with users:manage; everyone
 * else (users:view only) sees the same table without them. Delete guards live
 * server-side (skips you, admins, and users whose order history blocks a hard
 * delete — those are reported so you can suspend instead).
 */
export function UsersBulkList({
  users,
  canManage,
  roleAction,
  bulkDelete,
  bulkSuspend,
}: {
  users: UserRow[];
  canManage: boolean;
  roleAction: (fd: FormData) => Promise<void>;
  bulkDelete: (fd: FormData) => Promise<BulkResult>;
  bulkSuspend: (fd: FormData) => Promise<BulkResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const allSelected = users.length > 0 && selected.size === users.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(users.map((u) => u.id)));
  const clear = () => setSelected(new Set());

  function run(action: (fd: FormData) => Promise<BulkResult>, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setMsg(null);
    const ids = Array.from(selected);
    start(async () => {
      const fd = new FormData();
      fd.set('ids', ids.join(','));
      try {
        const r = await action(fd);
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) clear();
        router.refresh();
      } catch (e) {
        setMsg({ ok: false, text: e instanceof Error ? e.message : 'Action failed.' });
      }
    });
  }

  return (
    <div className="space-y-3">
      {canManage && selected.size > 0 && (
        <div className="sticky top-16 z-30 flex items-center gap-2 flex-wrap rounded-2xl border-2 border-primary/40 bg-primary/[0.06] backdrop-blur px-4 py-2.5 shadow-sm">
          <span className="text-xs font-bold">{selected.size} selected</span>
          <span className="flex-1" />
          <button
            type="button"
            disabled={pending}
            onClick={() => run(bulkSuspend)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-xs font-bold hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
            Suspend {selected.size}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                bulkDelete,
                `Permanently delete ${selected.size} user${selected.size === 1 ? '' : 's'}? Admins and users with orders are skipped automatically. This cannot be undone.`,
              )
            }
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs font-bold hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete {selected.size}
          </button>
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-foreground/10"
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {msg && (
        <p className={`text-xs font-semibold px-1 ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>
          {msg.text}
        </p>
      )}

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                {canManage && (
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={selectAll}
                      className="h-4 w-4 accent-primary align-middle"
                      aria-label="Select all on this page"
                    />
                  </th>
                )}
                <th className="px-5 py-3 font-bold">Name</th>
                <th className="px-5 py-3 font-bold">Email</th>
                <th className="px-5 py-3 font-bold">Company</th>
                <th className="px-5 py-3 font-bold">Role</th>
                <th className="px-5 py-3 font-bold">Joined</th>
                <th className="px-5 py-3 font-bold text-right">Quick view</th>
                <th className="px-5 py-3 font-bold">Set role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id} className={`hover:bg-foreground/[0.02] ${selected.has(u.id) ? 'bg-primary/5' : ''}`}>
                  {canManage && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(u.id)}
                        onChange={() => toggle(u.id)}
                        className="h-4 w-4 accent-primary align-middle"
                        aria-label={`Select ${u.name}`}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3 font-medium">
                    <UserQuickTrigger id={u.id} className="text-left hover:text-primary hover:underline">
                      {u.name}
                    </UserQuickTrigger>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{u.email}</td>
                  <td className="px-5 py-3 text-muted-foreground">{u.company ?? '—'}</td>
                  <td className="px-5 py-3">
                    <Badge variant={u.role === 'ADMIN' ? 'accent' : u.role === 'SELLER' ? 'success' : 'secondary'}>
                      {ROLE_LABEL[u.role] ?? u.role.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">{u.joinedLabel}</td>
                  <td className="px-5 py-3 text-right">
                    <UserQuickTrigger
                      id={u.id}
                      className="inline-flex items-center justify-center h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-foreground/5"
                    >
                      Open card
                    </UserQuickTrigger>
                  </td>
                  <td className="px-5 py-3">
                    <RoleSelect userId={u.id} current={u.role} action={roleAction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
