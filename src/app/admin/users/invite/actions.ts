'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession, getAdminCaps } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { CAPABILITY_PRESETS, capsAllow } from '@/lib/capabilities';
import { trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { getSecurityPolicy } from '@/lib/security/policy';
import { stepUpRequired, type StepUpRequired } from '@/lib/security/stepup';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { canInvite, hashInviteToken, inviteUrl, newInviteToken } from '@/lib/security/staff-invites';

/** Invite a staff member by e-mail with a permission preset (B21 staff onboarding). */
export async function createStaffInvite(formData: FormData): Promise<{ ok: boolean; message: string; link?: string } | StepUpRequired> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/users/invite' });
  const caps = await getAdminCaps();
  if (!capsAllow(caps, 'users:manage')) return { ok: false, message: 'Inviting staff needs the users:manage permission.' };
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const preset = String(formData.get('preset') ?? '');
  const check = await canInvite(caps, email, preset);
  if (!check.ok) {
    await audit('staff.invite.refused', email, check.reason);
    return { ok: false, message: check.reason };
  }
  const existing = await prisma.user.findUnique({ where: { email }, select: { role: true } });
  if (existing?.role === 'ADMIN') return { ok: false, message: `${email} is already an admin — change their permissions on their user card.` };
  const step = await stepUpRequired('staff.invite');
  if (step) return step;
  const policy = await getSecurityPolicy();
  const token = newInviteToken();
  const p = CAPABILITY_PRESETS[preset];
  // One open invitation per address: older open ones are withdrawn.
  await prisma.staffInvite.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const inv = await prisma.staffInvite.create({
    data: {
      email,
      preset,
      caps: p.caps,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(Date.now() + policy.STAFF_INVITE_TTL_HOURS * 3600_000),
      invitedById: session.user.id,
      invitedByEmail: session.user.email,
    },
  });
  const link = inviteUrl(token);
  const site = process.env.SITE_NAME || 'lab2date';
  const twoFa = policy.TWO_FACTOR_REQUIRED_ROLES.includes('ADMIN');
  const sent = await trySendEmail(
    {
      to: email,
      subject: `You are invited to the ${site} admin team`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#0E4F40;">Join the ${escapeHtml(site)} admin team</h2>
        <p>${escapeHtml(session.user.email)} invited you as staff with the role <strong>${escapeHtml(p.label)}</strong>.</p>
        <p style="margin:22px 0;"><a href="${escapeHtml(link)}" style="background:#0E4F40;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Accept the invitation</a></p>
        <p>Sign in (or create an account) with <strong>${escapeHtml(email)}</strong>, then accept.${twoFa ? ' You will be asked to set up an authenticator app on your phone.' : ''}</p>
        <p style="color:#6b7280;font-size:13px;">The link expires in ${policy.STAFF_INVITE_TTL_HOURS} hours. Not expecting this? Ignore this e-mail.</p>
      </div>`,
      text: `${session.user.email} invited you to the ${site} admin team as ${p.label}.\n\nAccept: ${link}\n\nSign in or create an account with ${email}, then accept.${twoFa ? ' You will set up an authenticator app.' : ''} The link expires in ${policy.STAFF_INVITE_TTL_HOURS} hours.`,
    },
    'staff-invite',
  );
  await audit('staff.invite', inv.id, `${email} as ${p.label}${sent.ok ? '' : ` (e-mail failed: ${sent.error})`}`);
  await alertSuperAdmins('Staff invitation sent', [`${session.user.email} invited ${email} as ${p.label}.`], '/admin/users/invite');
  revalidatePath('/admin/users/invite');
  return sent.ok
    ? { ok: true, message: `Invitation e-mailed to ${email}. It expires in ${policy.STAFF_INVITE_TTL_HOURS} hours.` }
    : {
        ok: false,
        message: `The invitation was created but the e-mail to ${email} could not be sent (${sent.error}). Give them this link yourself — it only works for ${email}:`,
        link,
      };
}

export async function revokeStaffInvite(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/users/invite' });
  if (!capsAllow(await getAdminCaps(), 'users:manage')) return { ok: false, message: 'Needs the users:manage permission.' };
  const id = String(formData.get('id') ?? '');
  const r = await prisma.staffInvite.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) return { ok: false, message: 'This invitation is no longer open.' };
  await audit('staff.invite.revoked', id);
  revalidatePath('/admin/users/invite');
  return { ok: true, message: 'Invitation withdrawn.' };
}
