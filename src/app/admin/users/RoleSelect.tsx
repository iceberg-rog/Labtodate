'use client';

import { UserRole } from '@prisma/client';

const ROLES: UserRole[] = ['BUYER', 'SELLER', 'ADMIN'];

export function RoleSelect({
  userId,
  current,
  action,
}: {
  userId: string;
  current: UserRole;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <select
        name="role"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 px-2 rounded-md border border-border bg-card text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </form>
  );
}
