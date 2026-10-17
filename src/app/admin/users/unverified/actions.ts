'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { getSecurityPolicy } from '@/lib/security/policy';
import { stepUpRequired, type StepUpRequired } from '@/lib/security/stepup';
import { parseAbandonedFilter, purgeAbandoned } from '@/lib/security/unverified';

/**
 * Delete the abandoned unverified accounts the page previewed. Needs
 * users:manage and a fresh authenticator code (step-up "users.delete");
 * refuses when the filter now matches more accounts than were confirmed.
 */
export async function purgeUnverifiedAccounts(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/users/unverified' });
  if (!(await hasCapability('users:manage'))) {
    return { ok: false, message: 'Deleting accounts needs the users:manage permission.' };
  }
  const policy = await getSecurityPolicy();
  const filter = parseAbandonedFilter(
    { days: formData.get('days') ?? undefined, from: formData.get('from') ?? undefined, domain: formData.get('domain') ?? undefined },
    policy.UNVERIFIED_PURGE_DAYS,
  );
  if (!filter) return { ok: false, message: 'Check the filter: days must be a whole number and the date a valid date.' };
  const expected = Number(formData.get('expected'));
  if (!Number.isInteger(expected) || expected < 1) return { ok: false, message: 'Preview the accounts first.' };
  const step = await stepUpRequired('users.delete');
  if (step) return step;
  const r = await purgeAbandoned(filter, { expected, actor: { email: session.user.email, id: session.user.id }, source: 'admin' });
  if (r.refused) return { ok: false, message: r.refused };
  revalidatePath('/admin/users/unverified');
  revalidatePath('/admin/users');
  return {
    ok: true,
    message: r.deleted
      ? `Deleted ${r.deleted} unverified account${r.deleted === 1 ? '' : 's'}. The list of addresses is in the audit log (users.purge-unverified).`
      : 'Nothing was deleted: none of the previewed accounts still qualifies.',
  };
}
