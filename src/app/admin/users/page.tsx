import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { setUserRole } from '../actions';
import { UserRole } from '@prisma/client';
import { RoleSelect } from './RoleSelect';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { UserQuickView, UserQuickTrigger } from '@/components/admin/UserQuickView';

export const dynamic = 'force-dynamic';

async function updateRole(formData: FormData) {
  'use server';
  await setUserRole(String(formData.get('userId')), formData.get('role') as UserRole);
}

const PAGE_SIZE = 50;

// We deliberately do NOT surface the literal "SELLER" string to operators —
// the public product has no "become a seller" funnel. Internal supplier
// accounts (legacy SELLER role) are relabelled "internal supplier".
const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'admin',
  BUYER: 'buyer',
  SELLER: 'internal supplier',
};

export default async function AdminUsersPage(
  props: {
    searchParams: Promise<{ q?: string; page?: string; role?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('users:view');
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const roleFilter = (searchParams.role as UserRole | undefined) ?? undefined;

  const where = {
    ...(roleFilter ? { role: roleFilter } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { company: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, users, byRole] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
      include: { company: { select: { name: true } } },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const roleCount = (r: UserRole) =>
    byRole.find((b) => b.role === r)?._count._all ?? 0;

  const pillHref = (r: UserRole | undefined) => {
    const sp = new URLSearchParams();
    if (r) sp.set('role', r);
    if (q) sp.set('q', q);
    const s = sp.toString();
    return s ? `/admin/users?${s}` : '/admin/users';
  };

  return (
    <div className="space-y-6">
      <UserQuickView />

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Users</h1>
        <p className="text-muted-foreground mt-1">
          {total} account{total === 1 ? '' : 's'}
          {roleFilter ? ` · ${ROLE_LABEL[roleFilter]}` : ''}
          {q ? ` · matching “${q}”` : ''}
          {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RolePill href={pillHref(undefined)} active={!roleFilter} label="All" count={roleCount('ADMIN') + roleCount('BUYER') + roleCount('SELLER')} />
        <RolePill href={pillHref('BUYER')} active={roleFilter === 'BUYER'} label="Buyers" count={roleCount('BUYER')} />
        <RolePill href={pillHref('ADMIN')} active={roleFilter === 'ADMIN'} label="Admins" count={roleCount('ADMIN')} accent="violet" />
        <RolePill href={pillHref('SELLER')} active={roleFilter === 'SELLER'} label="Internal suppliers" count={roleCount('SELLER')} accent="sky" hidden={roleCount('SELLER') === 0} />
      </div>

      <AdminSearch basePath="/admin/users" q={q} placeholder="Search name, email, company…" />

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
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
              <tr key={u.id} className="hover:bg-foreground/[0.02]">
                <td className="px-5 py-3 font-medium">
                  <UserQuickTrigger id={u.id} className="text-left hover:text-primary hover:underline">
                    {u.name}
                  </UserQuickTrigger>
                </td>
                <td className="px-5 py-3 text-muted-foreground">{u.email}</td>
                <td className="px-5 py-3 text-muted-foreground">{u.company?.name ?? '—'}</td>
                <td className="px-5 py-3">
                  <Badge variant={u.role === 'ADMIN' ? 'accent' : u.role === 'SELLER' ? 'success' : 'secondary'}>
                    {ROLE_LABEL[u.role]}
                  </Badge>
                </td>
                <td className="px-5 py-3 text-muted-foreground tabular-nums">
                  {new Date(u.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                </td>
                <td className="px-5 py-3 text-right">
                  <UserQuickTrigger
                    id={u.id}
                    className="inline-flex items-center justify-center h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-foreground/5"
                  >
                    Open card
                  </UserQuickTrigger>
                </td>
                <td className="px-5 py-3">
                  <RoleSelect userId={u.id} current={u.role} action={updateRole} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AdminPager basePath="/admin/users" page={page} totalPages={totalPages} total={total} q={q} status={roleFilter} />

      <p className="text-[11px] text-muted-foreground -mt-2">
        Click a name (or “Open card”) to see the user’s activity in a popup without leaving this page.
        “Internal supplier” is our legacy ingestion role — there is no public seller signup.
      </p>
    </div>
  );
}

function RolePill({
  href,
  active,
  label,
  count,
  accent,
  hidden,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
  accent?: 'violet' | 'sky';
  hidden?: boolean;
}) {
  if (hidden && !active) return <span />;
  const tint =
    accent === 'violet'
      ? 'text-violet-700'
      : accent === 'sky'
        ? 'text-sky-700'
        : 'text-foreground';
  return (
    <a
      href={href}
      className={`rounded-2xl border p-4 transition-colors ${
        active
          ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
          : 'border-border bg-card hover:bg-foreground/[0.03]'
      }`}
    >
      <p className={`text-2xl font-bold tabular-nums ${tint}`}>{count}</p>
      <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mt-0.5">
        {label}
      </p>
    </a>
  );
}
