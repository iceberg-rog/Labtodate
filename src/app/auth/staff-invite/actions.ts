'use server';

import { prisma } from '@/lib/db';
import { getActiveSession } from '@/lib/auth-server';
import { auditAs } from '@/lib/observability';
import { clientIpFrom } from '@/lib/ratelimit';
import { headers } from 'next/headers';
import { CAPABILITY_PRESETS, canGrantCapability } from '@/lib/capabilities';
import { adminEmailAllowed, getSecurityPolicy } from '@/lib/security/policy';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { hashInviteToken, lookupInvite } from '@/lib/security/staff-invites';

/**
 * Accept a staff invitation: only while signed in with the invited (verified)
 * address, and only if the person who invited is still allowed to grant it.
 */
export async function acceptStaffInvite(token: string): Promise<{ ok: boolean; message: string }> {
  const session = await getActiveSession();
  if (!session) return { ok: false, message: 'Sign in first.' };
  const inv = await lookupInvite(token);
  if (inv.state !== 'open') return { ok: false, message: 'This invitation is no longer valid.' };
  if (session.user.email.toLowerCase() !== inv.email.toLowerCase()) {
    return { ok: false, message: `This invitation is for ${inv.email}; you are signed in as ${session.user.email}.` };
  }
  const policy = await getSecurityPolicy();
  const inviter = await prisma.user.findUnique({
    where: { id: inv.invitedById },
    select: { role: true, adminCaps: true, suspendedAt: true },
  });
  const inviterOk =
    !!inviter &&
    inviter.role === 'ADMIN' &&
    !inviter.suspendedAt &&
    (!policy.ONLY_SUPER_ADMIN_CREATES_ADMINS || inviter.adminCaps.includes('*')) &&
    inv.caps.every((c) => canGrantCapability(inviter.adminCaps, c));
  if (!inviterOk || !adminEmailAllowed(policy, inv.email)) {
    return { ok: false, message: 'This invitation can no longer be accepted — ask for a new one.' };
  }
  const claimed = await prisma.$transaction(async (tx) => {
    const r = await tx.staffInvite.updateMany({
      where: { tokenHash: hashInviteToken(token), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedUserId: session.user.id },
    });
    if (!r.count) return false;
    await tx.user.update({ where: { id: session.user.id }, data: { role: 'ADMIN', adminCaps: inv.caps } });
    return true;
  });
  if (!claimed) return { ok: false, message: 'This invitation is no longer valid.' };
  const label = CAPABILITY_PRESETS[inv.preset]?.label ?? inv.preset;
  await auditAs(
    { email: session.user.email, id: session.user.id, ip: clientIpFrom(await headers()) },
    'staff.invite.accepted',
    session.user.id,
    `${label} (invited by ${inv.invitedByEmail})`,
  );
  await alertSuperAdmins('Staff invitation accepted', [`${session.user.email} is now an admin (${label}), invited by ${inv.invitedByEmail}.`], `/admin/users/${session.user.id}`);
  return { ok: true, message: 'Welcome to the team.' };
}
