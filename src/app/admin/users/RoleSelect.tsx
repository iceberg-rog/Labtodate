'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@prisma/client';

const ROLES: UserRole[] = ['BUYER', 'SELLER', 'ADMIN'];
const LABEL: Record<UserRole, string> = { BUYER: 'buyer', SELLER: 'internal supplier', ADMIN: 'admin' };

/**
 * Role dropdown. Asks before applying (it used to apply on change, so a slip
 * of the mouse could promote someone to ADMIN), and shows the server's answer
 * inline — e.g. the "last admin" refusal used to crash the page.
 */
export function RoleSelect({
  userId,
  current,
  action,
}: {
  userId: string;
  current: UserRole;
  action: (formData: FormData) => Promise<{ ok: boolean; message: string } | void>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span className="inline-flex flex-col gap-1">
      <select
        name="role"
        defaultValue={current}
        disabled={pending}
        onChange={(e) => {
          const select = e.currentTarget;
          const next = select.value as UserRole;
          if (next === current) return;
          const warn = next === 'ADMIN' ? ' Admins get access to the admin console.' : '';
          if (!window.confirm(`Change this user’s role from ${LABEL[current]} to ${LABEL[next]}?${warn}`)) {
            select.value = current;
            return;
          }
          setMsg(null);
          start(async () => {
            const fd = new FormData();
            fd.set('userId', userId);
            fd.set('role', next);
            try {
              const r = await action(fd);
              if (r && !r.ok) {
                select.value = current;
                setMsg(r);
              } else {
                router.refresh();
              }
            } catch {
              select.value = current;
              setMsg({ ok: false, message: 'Role change failed — please try again.' });
            }
          });
        }}
        className="h-8 px-2 rounded-md border border-border bg-card text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {msg && !msg.ok && <span className="text-[11px] font-semibold text-red-600 dark:text-red-400 max-w-[220px]">{msg.message}</span>}
    </span>
  );
}
