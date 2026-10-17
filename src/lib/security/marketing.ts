import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { isDeliverableEmail } from '@/lib/email-address';
import { escapeHtml } from '@/lib/email-html';
import { getSecurityPolicy } from './policy';

/**
 * Marketing e-mail rules (A19): who may receive offers / announcements,
 * signed one-click unsubscribe links (RFC 8058), the legal footer, and the
 * consent history.
 */

const PAID_STATES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
export const MARKETING_SCOPE = 'MARKETING';

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET || '';
  if (!s) throw new Error('BETTER_AUTH_SECRET is not set');
  return s;
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function sign(email: string, scope: string): string {
  return createHmac('sha256', secret()).update(`unsubscribe:${scope}:${email.toLowerCase()}`).digest('base64url').slice(0, 32);
}

/** Stateless, unguessable token for one address + category. */
export function unsubscribeToken(email: string, scope = MARKETING_SCOPE): string {
  return `${b64url(email.toLowerCase())}.${scope === MARKETING_SCOPE ? 'm' : scope}.${sign(email, scope)}`;
}

export function verifyUnsubscribeToken(token: string | null | undefined): { email: string; scope: string } | null {
  if (!token) return null;
  const [e, s, mac] = token.split('.');
  if (!e || !s || !mac) return null;
  let email: string;
  try {
    email = Buffer.from(e, 'base64url').toString('utf8').toLowerCase();
  } catch {
    return null;
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  const scope = s === 'm' ? MARKETING_SCOPE : s;
  const expected = Buffer.from(sign(email, scope));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { email, scope };
}

function siteUrl(): string {
  return (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
}

export function unsubscribeLinks(email: string): { page: string; oneClick: string } {
  const t = encodeURIComponent(unsubscribeToken(email));
  return { page: `${siteUrl()}/email/unsubscribe?t=${t}`, oneClick: `${siteUrl()}/api/email/unsubscribe?t=${t}` };
}

/** RFC 2369 + RFC 8058 headers for a marketing e-mail. */
export function listUnsubscribeHeaders(email: string): Record<string, string> {
  const { oneClick } = unsubscribeLinks(email);
  return {
    'List-Unsubscribe': `<${oneClick}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export type LegalIdentity = { lines: string[]; missing: string[] };

/** Sender identity for the footer (e-commerce + marketing rules). Missing parts are reported, never invented. */
export function legalIdentity(): LegalIdentity {
  const name = (process.env.COMPANY_LEGAL_NAME || '').trim();
  const address = (process.env.COMPANY_ADDRESS || '').replace(/\s*\n\s*/g, ', ').trim();
  const country = (process.env.COMPANY_COUNTRY || '').trim();
  const kvk = (process.env.COMPANY_KVK || '').trim();
  const vat = (process.env.COMPANY_VAT || '').trim();
  const support = (process.env.SUPPORT_EMAIL || '').trim();
  const missing: string[] = [];
  if (!name) missing.push('legal company name');
  if (!address) missing.push('company address');
  if (!kvk) missing.push('KvK number');
  const lines = [
    [name, [address, country].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
    [kvk && `KvK ${kvk}`, vat && `VAT ${vat}`, isDeliverableEmail(support) ? support : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);
  return { lines, missing };
}

export type RecipientReason = 'opted-in' | 'customer';
export type AudienceKey = 'ALL' | 'BUYER' | 'SELLER';

export type AudienceBreakdown = {
  /** Accounts in the audience (buyers / suppliers; staff never). */
  accounts: number;
  inApp: number;
  emailable: { userId: string; email: string; name: string; reason: RecipientReason }[];
  excluded: { notVerified: number; suspended: number; noConsent: number; unsubscribed: number; placeholder: number };
};

function roleWhere(audience: AudienceKey) {
  return audience === 'BUYER' ? { role: 'BUYER' as const } : audience === 'SELLER' ? { role: 'SELLER' as const } : { role: { in: ['BUYER' as const, 'SELLER' as const] } };
}

/**
 * Who gets an announcement, and why everyone else doesn't. MARKETING needs
 * consent (opt-in) or — when the soft opt-in setting is on — a past purchase
 * and no objection; SERVICE goes to every verified, active account.
 */
export async function audienceBreakdown(audience: AudienceKey, category: 'MARKETING' | 'SERVICE'): Promise<AudienceBreakdown> {
  const policy = await getSecurityPolicy();
  const users = await prisma.user.findMany({
    where: roleWhere(audience),
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      suspendedAt: true,
      marketingOptIn: true,
      ordersAsBuyer: { where: { status: { in: [...PAID_STATES] } }, select: { id: true }, take: 1 },
    },
  });
  const suppressed = new Set(
    (await prisma.emailSuppression.findMany({ where: { scope: MARKETING_SCOPE }, select: { email: true } })).map((s) => s.email.toLowerCase()),
  );
  const out: AudienceBreakdown = {
    accounts: users.length,
    inApp: 0,
    emailable: [],
    excluded: { notVerified: 0, suspended: 0, noConsent: 0, unsubscribed: 0, placeholder: 0 },
  };
  for (const u of users) {
    if (u.suspendedAt) {
      out.excluded.suspended++;
      continue;
    }
    out.inApp++;
    if (!u.emailVerified) {
      out.excluded.notVerified++;
      continue;
    }
    if (!isDeliverableEmail(u.email)) {
      out.excluded.placeholder++;
      continue;
    }
    if (category === 'SERVICE') {
      out.emailable.push({ userId: u.id, email: u.email, name: u.name, reason: 'customer' });
      continue;
    }
    if (suppressed.has(u.email.toLowerCase())) {
      out.excluded.unsubscribed++;
      continue;
    }
    if (u.marketingOptIn) out.emailable.push({ userId: u.id, email: u.email, name: u.name, reason: 'opted-in' });
    else if (policy.MARKETING_SOFT_OPT_IN && u.ordersAsBuyer.length > 0) out.emailable.push({ userId: u.id, email: u.email, name: u.name, reason: 'customer' });
    else out.excluded.noConsent++;
  }
  return out;
}

/** Does this person currently receive marketing e-mail (explicit or soft opt-in)? */
export async function marketingStatus(userId: string): Promise<{ receiving: boolean; basis: 'opted-in' | 'customer' | 'none' | 'unsubscribed'; softOptIn: boolean; customer: boolean }> {
  const policy = await getSecurityPolicy();
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, marketingOptIn: true, ordersAsBuyer: { where: { status: { in: [...PAID_STATES] } }, select: { id: true }, take: 1 } },
  });
  if (!u) return { receiving: false, basis: 'none', softOptIn: policy.MARKETING_SOFT_OPT_IN, customer: false };
  const customer = u.ordersAsBuyer.length > 0;
  if (u.marketingOptIn) return { receiving: true, basis: 'opted-in', softOptIn: policy.MARKETING_SOFT_OPT_IN, customer };
  const sup = await prisma.emailSuppression.findUnique({ where: { email_scope: { email: u.email.toLowerCase(), scope: MARKETING_SCOPE } } });
  if (sup) return { receiving: false, basis: 'unsubscribed', softOptIn: policy.MARKETING_SOFT_OPT_IN, customer };
  if (policy.MARKETING_SOFT_OPT_IN && customer) return { receiving: true, basis: 'customer', softOptIn: true, customer };
  return { receiving: false, basis: 'none', softOptIn: policy.MARKETING_SOFT_OPT_IN, customer };
}

/**
 * Record a consent decision: GRANTED (explicit opt-in) or WITHDRAWN (opt-out /
 * unsubscribe — also covers the soft opt-in, via the suppression list).
 */
export async function setMarketingConsent(
  target: { userId?: string | null; email: string },
  granted: boolean,
  source: 'preferences' | 'unsubscribe-link' | 'one-click' | 'admin',
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  const email = target.email.toLowerCase();
  const user = target.userId
    ? await prisma.user.findUnique({ where: { id: target.userId }, select: { id: true } })
    : await prisma.user.findUnique({ where: { email }, select: { id: true } });
  await prisma.$transaction([
    ...(user
      ? [
          prisma.user.update({
            where: { id: user.id },
            data: { marketingOptIn: granted, marketingConsentAt: new Date(), marketingConsentSource: source },
          }),
        ]
      : []),
    granted
      ? prisma.emailSuppression.deleteMany({ where: { email, scope: MARKETING_SCOPE } })
      : prisma.emailSuppression.upsert({
          where: { email_scope: { email, scope: MARKETING_SCOPE } },
          update: {},
          create: { email, scope: MARKETING_SCOPE, reason: source === 'admin' ? 'ADMIN' : 'UNSUBSCRIBE' },
        }),
    prisma.consentEvent.create({
      data: {
        userId: user?.id ?? null,
        email,
        kind: 'MARKETING_EMAIL',
        action: granted ? 'GRANTED' : 'WITHDRAWN',
        source,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
      },
    }),
  ]);
}

/** The announcement e-mail: content, why they get it, unsubscribe / preferences, legal identity. */
export function renderAnnouncementEmail(opts: {
  title: string;
  body: string;
  link: string;
  name: string;
  email: string;
  category: 'MARKETING' | 'SERVICE';
  reason: RecipientReason;
  site: string;
}): { html: string; text: string } {
  const legal = legalIdentity();
  const prefs = `${siteUrl()}/app/email-preferences`;
  const { page: unsub } = unsubscribeLinks(opts.email);
  const why =
    opts.category === 'SERVICE'
      ? `This is a service message about your ${opts.site} account.`
      : opts.reason === 'opted-in'
        ? `You receive this because you asked for offers and news from ${opts.site}.`
        : `You receive this because you bought from ${opts.site}. You can object to these e-mails at any time.`;
  const bodyHtml = escapeHtml(opts.body).replace(/\r?\n/g, '<br>');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;">
    <h2 style="color:#0E4F40;">${escapeHtml(opts.title)}</h2>
    <p>Hi ${escapeHtml(opts.name || 'there')},</p>
    <div style="font-size:14px;line-height:1.7;color:#333;">${bodyHtml}</div>
    <p style="margin:22px 0;"><a href="${escapeHtml(opts.link)}" style="background:#0E4F40;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">View on ${escapeHtml(opts.site)}</a></p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
    <p style="color:#6b7280;font-size:12px;line-height:1.6;margin:0 0 6px;">${escapeHtml(why)}
      ${opts.category === 'MARKETING' ? `<a href="${escapeHtml(unsub)}" style="color:#6b7280;">Unsubscribe</a> · ` : ''}<a href="${escapeHtml(prefs)}" style="color:#6b7280;">E-mail preferences</a></p>
    ${legal.lines.map((l) => `<p style="color:#9ca3af;font-size:11px;margin:0;">${escapeHtml(l)}</p>`).join('')}
  </div>`;
  const text = [
    opts.title,
    '',
    `Hi ${opts.name || 'there'},`,
    '',
    opts.body,
    '',
    `View on ${opts.site}: ${opts.link}`,
    '',
    '—',
    why,
    ...(opts.category === 'MARKETING' ? [`Unsubscribe: ${unsub}`] : []),
    `E-mail preferences: ${prefs}`,
    ...legal.lines,
  ].join('\n');
  return { html, text };
}
