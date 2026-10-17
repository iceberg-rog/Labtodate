import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { CAPABILITY_PRESETS, canGrantCapability } from '@/lib/capabilities';
import { adminEmailAllowed, getSecurityPolicy } from './policy';

/** Invitation tokens are stored only as a SHA-256 hash. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function inviteUrl(token: string): string {
  return `${(process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '')}/auth/staff-invite?token=${encodeURIComponent(token)}`;
}

export type InviteCheck = { ok: true } | { ok: false; reason: string };

/** Rules for inviting `email` with `preset` by an actor holding `actorCaps` (pure apart from the policy). */
export async function canInvite(actorCaps: string[], email: string, preset: string): Promise<InviteCheck> {
  const policy = await getSecurityPolicy();
  if (policy.ONLY_SUPER_ADMIN_CREATES_ADMINS && !actorCaps.includes('*')) {
    return { ok: false, reason: 'Only a super-admin can invite staff (Settings → Security).' };
  }
  const p = CAPABILITY_PRESETS[preset];
  if (!p) return { ok: false, reason: 'Choose which permissions the new staff member gets.' };
  const notGrantable = p.caps.filter((c) => !canGrantCapability(actorCaps, c));
  if (notGrantable.length) return { ok: false, reason: `You can’t grant ${notGrantable.join(', ')}.` };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: 'Enter a valid e-mail address.' };
  if (!adminEmailAllowed(policy, email)) {
    return { ok: false, reason: `${email} is not on an allowed admin e-mail domain (${policy.ADMIN_EMAIL_DOMAINS}).` };
  }
  return { ok: true };
}

export type InviteState =
  | { state: 'invalid' }
  | { state: 'expired' | 'revoked' | 'accepted'; email: string }
  | { state: 'open'; id: string; email: string; preset: string; caps: string[]; invitedByEmail: string; invitedById: string; expiresAt: Date };

export async function lookupInvite(token: string | null | undefined): Promise<InviteState> {
  if (!token || token.length < 20) return { state: 'invalid' };
  const inv = await prisma.staffInvite.findUnique({ where: { tokenHash: hashInviteToken(token) } });
  if (!inv) return { state: 'invalid' };
  if (inv.revokedAt) return { state: 'revoked', email: inv.email };
  if (inv.acceptedAt) return { state: 'accepted', email: inv.email };
  if (inv.expiresAt < new Date()) return { state: 'expired', email: inv.email };
  return {
    state: 'open',
    id: inv.id,
    email: inv.email,
    preset: inv.preset,
    caps: inv.caps,
    invitedByEmail: inv.invitedByEmail,
    invitedById: inv.invitedById,
    expiresAt: inv.expiresAt,
  };
}
