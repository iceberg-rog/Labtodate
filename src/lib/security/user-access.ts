import { revalidatePath } from 'next/cache';
import { UserRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdminCaps, requireSession } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import {
  CAPABILITY_PRESETS,
  capsAllow,
  capsChangeProblems,
  canGrantCapability,
  isKnownCapability,
} from '@/lib/capabilities';
import { trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { adminEmailAllowed, getSecurityPolicy } from './policy';
import { activeSuperAdmins, alertSuperAdmins, countOtherActiveSuperAdmins } from './alerts';
import { stepUpRequired, type StepUpRequired } from './stepup';

/**
 * Server-side rules for every change to who can do what (A17):
 *  - nobody changes their own role or permissions;
 *  - you can grant only permissions you hold; '*', users:manage,
 *    settings:write, security:manage and gdpr:manage need a super-admin;
 *  - someone with more access than you is out of your reach;
 *  - at least one active super-admin always remains;
 *  - making someone an admin needs a super-admin (policy, default on), a
 *    chosen preset and an allowed e-mail domain (policy);
 *  - demotion empties adminCaps and signs the person out everywhere, in one
 *    transaction (re-promotion never silently restores old permissions);
 *  - each change, and each refused attempt, is audited and reported to every
 *    super-admin; the affected person gets an e-mail.
 */
export type AccessResult = { ok: boolean; message: string } | StepUpRequired;

const ROLE_LABEL: Record<UserRole, string> = { BUYER: 'buyer', SELLER: 'internal supplier', ADMIN: 'admin' };

type Actor = { id: string; email: string; caps: string[] };

async function currentActor(): Promise<Actor> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/users' });
  return { id: session.user.id, email: session.user.email, caps: await getAdminCaps() };
}

function describeCaps(caps: string[]): string {
  if (caps.includes('*')) return 'super-admin (everything)';
  return caps.length ? caps.join(', ') : '(no permissions)';
}

async function refuse(actor: Actor, action: string, target: { id: string; email: string } | null, reasons: string[], attempted: string) {
  await audit(`${action}.refused`, target?.id, `${attempted} — ${reasons.join(' ')}`.slice(0, 1000));
  await alertSuperAdmins('Refused permission change', [
    `${actor.email} tried to ${attempted}${target ? ` for ${target.email}` : ''}.`,
    `Refused: ${reasons.join(' ')}`,
  ], target ? `/admin/users/${target.id}` : '/admin/audit');
  return { ok: false as const, message: reasons.join(' ') };
}

async function tellUser(email: string, subject: string, lines: string[]) {
  const site = process.env.SITE_NAME || 'Labtodate';
  await trySendEmail(
    {
      to: email,
      subject: `${site}: ${subject}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;">
        <h2 style="color:#0E4F40;font-size:18px;">${escapeHtml(subject)}</h2>
        ${lines.map((l) => `<p style="color:#374151;">${escapeHtml(l)}</p>`).join('')}
        <p style="color:#6b7280;font-size:13px;">If you didn’t expect this, reply to this e-mail or contact support.</p>
      </div>`,
      text: `${subject}\n\n${lines.join('\n')}`,
    },
    'access-change',
  );
}

function refreshUserPages(userId: string) {
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
}

/** Caps from a preset key or a list of checkboxes; '*' only via its preset or the explicit box. */
export function resolveRequestedCaps(preset: string | null | undefined, raw: string[]): { caps: string[] } | { error: string } {
  if (preset) {
    const p = CAPABILITY_PRESETS[preset];
    if (!p) return { error: 'Unknown preset.' };
    return { caps: [...p.caps] };
  }
  const caps = Array.from(new Set(raw.map((c) => c.trim()).filter(Boolean)));
  const unknown = caps.filter((c) => !isKnownCapability(c));
  if (unknown.length) return { error: `Unknown permission ${unknown.join(', ')}.` };
  return { caps };
}

/** Replace an admin's permissions. */
export async function changeUserCaps(userId: string, preset: string | null, raw: string[]): Promise<AccessResult> {
  const actor = await currentActor();
  if (!capsAllow(actor.caps, 'users:manage')) return { ok: false, message: 'You need the users:manage permission.' };
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, adminCaps: true, suspendedAt: true },
  });
  if (!target) return { ok: false, message: 'User not found.' };
  if (target.role !== 'ADMIN') return { ok: false, message: 'Permissions apply to admins only — make the user an admin first.' };
  const requested = resolveRequestedCaps(preset, raw);
  if ('error' in requested) return { ok: false, message: requested.error };
  const next = requested.caps;
  const problems = capsChangeProblems({
    actorId: actor.id,
    actorCaps: actor.caps,
    targetId: target.id,
    targetRole: target.role,
    targetCaps: target.adminCaps,
    nextCaps: next,
    otherActiveSuperAdmins: await countOtherActiveSuperAdmins(target.id),
  });
  if (problems.length) {
    return refuse(actor, 'user.caps', target, problems, `set permissions to ${describeCaps(next)}`);
  }
  const step = await stepUpRequired('users.caps');
  if (step) return step;
  const before = target.adminCaps;
  if (JSON.stringify([...before].sort()) === JSON.stringify([...next].sort())) {
    return { ok: true, message: 'Nothing changed — they already have exactly these permissions.' };
  }
  const lostPower = before.some((c) => !capsAllow(next, c));
  // Caps are read from the DB on every request, so the change applies to
  // their open sessions at once.
  await prisma.user.update({ where: { id: target.id }, data: { adminCaps: next } });
  await audit('user.caps', target.id, `${describeCaps(before)} → ${describeCaps(next)}`);
  await alertSuperAdmins('Admin permissions changed', [
    `${actor.email} changed the permissions of ${target.email}.`,
    `Before: ${describeCaps(before)}`,
    `After: ${describeCaps(next)}`,
  ], `/admin/users/${target.id}`);
  await tellUser(target.email, 'Your admin permissions changed', [
    `${lostPower ? 'Some of your admin permissions were removed.' : 'You were given new admin permissions.'}`,
    `Your permissions now: ${describeCaps(next)}.`,
  ]);
  refreshUserPages(target.id);
  return { ok: true, message: `Permissions saved: ${describeCaps(next)}.` };
}

/** Change someone's role. Promotion to ADMIN needs a preset. */
export async function changeUserRole(userId: string, role: string, preset: string | null): Promise<AccessResult> {
  const actor = await currentActor();
  if (!capsAllow(actor.caps, 'users:manage')) return { ok: false, message: 'You need the users:manage permission.' };
  if (!(Object.values(UserRole) as string[]).includes(role)) return { ok: false, message: 'Unknown role.' };
  const next = role as UserRole;
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, adminCaps: true, emailVerified: true, suspendedAt: true },
  });
  if (!target) return { ok: false, message: 'User not found.' };
  if (target.id === actor.id) {
    return refuse(actor, 'user.role', target, ['You can’t change your own role — ask another super-admin.'], `change their own role to ${ROLE_LABEL[next]}`);
  }
  if (target.role === next) return { ok: true, message: `Already ${ROLE_LABEL[next]}.` };
  const policy = await getSecurityPolicy();

  if (next === 'ADMIN') {
    // Promotion.
    if (policy.ONLY_SUPER_ADMIN_CREATES_ADMINS && !actor.caps.includes('*')) {
      return refuse(actor, 'user.role', target, ['Only a super-admin can make someone an admin (Settings → Security).'], 'make them an admin');
    }
    if (!preset) return { ok: false, message: 'Choose which permissions the new admin gets (a preset) before promoting.' };
    const p = CAPABILITY_PRESETS[preset];
    if (!p) return { ok: false, message: 'Unknown preset.' };
    if (!target.emailVerified) return { ok: false, message: 'This account hasn’t confirmed its e-mail address yet — it can’t become an admin.' };
    if (target.suspendedAt) return { ok: false, message: 'Lift the suspension first.' };
    if (!adminEmailAllowed(policy, target.email)) {
      return refuse(actor, 'user.role', target, [
        `${target.email} is not on an allowed admin e-mail domain (${policy.ADMIN_EMAIL_DOMAINS}). Change it in Settings → Security if this is intended.`,
      ], 'make them an admin');
    }
    const notGrantable = p.caps.filter((c) => !canGrantCapability(actor.caps, c));
    if (notGrantable.length) {
      return refuse(actor, 'user.role', target, [`You can’t grant ${notGrantable.join(', ')}.`], `make them an admin with the ${p.label} preset`);
    }
    const step = await stepUpRequired('users.role');
    if (step) return step;
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { role: 'ADMIN', adminCaps: p.caps } }),
      // Fresh sign-in: the new admin goes through two-factor set-up first.
      prisma.session.deleteMany({ where: { userId: target.id } }),
    ]);
    await audit('user.role', target.id, `${ROLE_LABEL[target.role]} → admin (${p.label}: ${describeCaps(p.caps)})`);
    await alertSuperAdmins('New admin', [
      `${actor.email} made ${target.email} an admin.`,
      `Permissions: ${describeCaps(p.caps)}.`,
    ], `/admin/users/${target.id}`);
    const twoFa = policy.TWO_FACTOR_REQUIRED_ROLES.includes('ADMIN');
    await tellUser(target.email, 'You are now an admin', [
      `${actor.email} gave your account admin access (${p.label}).`,
      twoFa
        ? 'Next time you sign in you will be asked to set up an authenticator app — admin accounts need it.'
        : 'Sign in again to use the admin console.',
    ]);
    refreshUserPages(target.id);
    return { ok: true, message: `${target.email} is now an admin (${p.label}). They were signed out and ${twoFa ? 'must set up two-factor sign-in' : 'must sign in again'}.` };
  }

  if (target.role === 'ADMIN') {
    // Demotion: same reach rules as taking every permission away.
    const problems = capsChangeProblems({
      actorId: actor.id,
      actorCaps: actor.caps,
      targetId: target.id,
      targetRole: target.role,
      targetCaps: target.adminCaps,
      nextCaps: [],
      otherActiveSuperAdmins: await countOtherActiveSuperAdmins(target.id),
    });
    const otherAdmins = await prisma.user.count({ where: { role: 'ADMIN', suspendedAt: null, NOT: { id: target.id } } });
    if (otherAdmins === 0) problems.push('This is the last active admin — promote someone else first.');
    if (problems.length) return refuse(actor, 'user.role', target, problems, `demote them to ${ROLE_LABEL[next]}`);
    const step = await stepUpRequired('users.role');
    if (step) return step;
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { role: next, adminCaps: [] } }),
      prisma.session.deleteMany({ where: { userId: target.id } }),
    ]);
    await audit('user.role', target.id, `admin (${describeCaps(target.adminCaps)}) → ${ROLE_LABEL[next]}; permissions cleared, signed out`);
    await alertSuperAdmins('Admin access removed', [
      `${actor.email} changed ${target.email} from admin to ${ROLE_LABEL[next]}.`,
      `Removed permissions: ${describeCaps(target.adminCaps)}. All their sessions were signed out.`,
    ], `/admin/users/${target.id}`);
    await tellUser(target.email, 'Your admin access was removed', [
      `Your account is now a ${ROLE_LABEL[next]} account. You were signed out on all devices.`,
    ]);
    refreshUserPages(target.id);
    return { ok: true, message: `${target.email} is now ${ROLE_LABEL[next]}: admin permissions removed and signed out everywhere.` };
  }

  // BUYER ↔ SELLER.
  const step = await stepUpRequired('users.role');
  if (step) return step;
  await prisma.user.update({ where: { id: target.id }, data: { role: next, adminCaps: [] } });
  await audit('user.role', target.id, `${ROLE_LABEL[target.role]} → ${ROLE_LABEL[next]}`);
  refreshUserPages(target.id);
  return { ok: true, message: `Role changed to ${ROLE_LABEL[next]}.` };
}

/**
 * Suspend / delete / reset 2FA of an admin: the actor must be able to reach
 * them (no acting on someone with more access, never yourself) and at least
 * one active super-admin must remain. Returns refusal reasons.
 */
export async function adminTargetProblems(
  actor: Actor,
  target: { id: string; role: string; adminCaps: string[] },
  removesAccess: boolean,
): Promise<string[]> {
  if (target.id === actor.id) return ['You can’t do this to your own account.'];
  if (target.role !== 'ADMIN') return [];
  return capsChangeProblems({
    actorId: actor.id,
    actorCaps: actor.caps,
    targetId: target.id,
    targetRole: target.role,
    targetCaps: target.adminCaps,
    nextCaps: removesAccess ? [] : target.adminCaps,
    otherActiveSuperAdmins: await countOtherActiveSuperAdmins(target.id),
  });
}

export async function getActor(): Promise<Actor> {
  return currentActor();
}

export { refuse as refuseAccessChange };

/** Lost authenticator: turn 2FA off for someone so they can set it up again. */
export async function resetUserTwoFactor(userId: string): Promise<AccessResult> {
  const actor = await currentActor();
  if (!capsAllow(actor.caps, 'users:manage')) return { ok: false, message: 'You need the users:manage permission.' };
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, adminCaps: true, twoFactorEnabled: true },
  });
  if (!target) return { ok: false, message: 'User not found.' };
  const problems = await adminTargetProblems(actor, target, false);
  if (problems.length) return refuse(actor, 'user.2fa_reset', target, problems, 'reset their two-factor sign-in');
  if (!target.twoFactorEnabled) {
    const rows = await prisma.twoFactor.count({ where: { userId } });
    if (!rows) return { ok: true, message: 'Two-factor sign-in is not set up on this account — nothing to reset.' };
  }
  const step = await stepUpRequired('users.2fa_reset');
  if (step) return step;
  await prisma.$transaction([
    prisma.twoFactor.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
  await audit('user.2fa_reset', userId, `by ${actor.email}`);
  await alertSuperAdmins('Two-factor sign-in reset', [
    `${actor.email} reset two-factor sign-in for ${target.email} (signed out everywhere).`,
  ], `/admin/users/${userId}`);
  await tellUser(target.email, 'Your two-factor sign-in was reset', [
    `${actor.email} removed the authenticator app from your account (for example because you lost your phone). You were signed out everywhere.`,
    'Sign in with your password and set up your authenticator app again.',
  ]);
  refreshUserPages(userId);
  return { ok: true, message: `Two-factor sign-in reset for ${target.email}. They must set it up again at their next sign-in.` };
}

/** For pages: super-admin count and whether the viewer can act on a target. */
export async function superAdminEmails(): Promise<string[]> {
  return (await activeSuperAdmins()).map((a) => a.email);
}
