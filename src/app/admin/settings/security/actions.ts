'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { applyPolicyWrites, getSecurityPolicy, planPolicySave, POLICY_DEFS } from '@/lib/security/policy';
import { stepUpRequired, type StepUpRequired } from '@/lib/security/stepup';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { getSettingStates, recordSettingChanges } from '@/lib/settings';
import { clientIpFrom } from '@/lib/ratelimit';

/**
 * Save Admin → Settings → Security. Needs security:manage (super-admins by
 * default) and a fresh authenticator code; every changed key is audited with
 * its old and new value and reported to all super-admins.
 */
export async function saveSecurityPolicy(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/settings/security' });
  if (!(await hasCapability('security:manage'))) {
    return { ok: false, message: 'Changing the security policy needs the security:manage permission (super-admins).' };
  }
  const input: Record<string, string | string[]> = {};
  for (const d of POLICY_DEFS) {
    const all = formData.getAll(d.key).map(String);
    input[d.key] = d.type === 'set' ? all : (all[0] ?? '');
  }
  const current = await getSecurityPolicy();
  const plan = planPolicySave(current, input);
  if (plan.problems.length) return { ok: false, message: `${plan.problems.join(' ')} Nothing was saved.` };
  if (!plan.changes.length) return { ok: true, message: 'Nothing changed.' };
  const step = await stepUpRequired('security.settings');
  if (step) return step;
  // Same Change history as every other setting (Settings → Change history).
  const before = await getSettingStates();
  await applyPolicyWrites(plan.writes);
  const h = await headers();
  await recordSettingChanges(
    plan.writes.map((w) => w.key),
    before,
    await getSettingStates(),
    { id: session.user.id, email: session.user.email, ip: clientIpFrom(h), userAgent: h.get('user-agent'), source: 'ADMIN' },
    // An emptied list ("nobody", "no actions") is stored as '' — record it as such.
    Object.fromEntries(plan.writes.filter((w) => w.value === '').map((w) => [w.key, ''])),
  );
  for (const c of plan.changes) {
    await audit('security.policy', c.key, `${c.label}: ${c.from} → ${c.to}`);
  }
  await alertSuperAdmins(
    'Security policy changed',
    [`${session.user.email} changed:`, ...plan.changes.map((c) => `• ${c.label}: ${c.from} → ${c.to}`)],
    '/admin/settings/security',
  );
  revalidatePath('/admin/settings/security');
  revalidatePath('/admin/settings');
  return { ok: true, message: `Saved ✓ ${plan.changes.map((c) => `${c.label}: ${c.to}`).join(' · ')}` };
}
