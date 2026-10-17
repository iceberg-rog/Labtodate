/**
 * Anonymous-mail guard rules — pure (no DB), unit-tested in rules.test.ts.
 *
 * Background (2026-10): scripts signed up through Tor with addresses on US
 * carriers' SMS gateways (…@txt.att.net) and had the site send verification
 * and reset e-mails from the business mailbox to strangers' phones. Every
 * e-mail now carries a trigger; the ones a visitor can cause without being
 * signed in ("anonymous") are limited per address, per domain and per hour,
 * and no e-mail at all goes to blocked or throw-away domains or to addresses
 * the mail server rejected before. The numbers are admin settings
 * (Settings → Security, group "E-mails a visitor can trigger").
 */

import { DISPOSABLE_DOMAINS_TEXT } from './disposable-domains';

export const EMAIL_TRIGGERS = {
  'auth.signup-code': { anonymous: true, label: 'Verification code' },
  'auth.verify-link': { anonymous: true, label: 'Verification link' },
  'auth.password-reset': { anonymous: true, label: '“Forgot password” link' },
  'auth.magic-link': { anonymous: true, label: 'Sign-in link' },
  'auth.notice': { anonymous: true, label: 'Sign-in notice (no account, already registered, links off, sign-in paused)' },
  'form.support': { anonymous: true, label: 'Support form confirmation (guest)' },
  'form.sell': { anonymous: true, label: 'Sell form confirmation (guest)' },
  account: { anonymous: false, label: 'Account security notice' },
  transactional: { anonymous: false, label: 'Orders, quotes, tickets, documents' },
  marketing: { anonymous: false, label: 'Announcements and offers' },
  admin: { anonymous: false, label: 'Sent by an admin' },
  internal: { anonymous: false, label: 'Staff copy or alert' },
} as const;
export type EmailTrigger = keyof typeof EMAIL_TRIGGERS;

export const ANONYMOUS_TRIGGERS = (Object.keys(EMAIL_TRIGGERS) as EmailTrigger[]).filter((t) => EMAIL_TRIGGERS[t].anonymous);

export function isAnonymousTrigger(t: string | null | undefined): boolean {
  return !!t && t in EMAIL_TRIGGERS && EMAIL_TRIGGERS[t as EmailTrigger].anonymous;
}

/**
 * Staff copies / alerts and admin-initiated sends bypass the guards (an admin
 * re-sending after fixing a typo must not be stopped by a suppression; the
 * staff inboxes are configured by the owner).
 */
export function bypassesGuards(t: EmailTrigger): boolean {
  return t === 'internal' || t === 'admin';
}

/** The bare, lower-cased address of "Name <a@b.c>" or "a@b.c". */
export function bareAddress(to: string): string {
  const inner = /<([^<>]+)>\s*$/.exec(to)?.[1] ?? to;
  return inner.trim().toLowerCase();
}

/** Lower-cased domain of an address ('' when there is none). */
export function emailDomain(addr: string): string {
  const a = bareAddress(addr);
  const at = a.lastIndexOf('@');
  return at < 0 ? '' : a.slice(at + 1).replace(/\.+$/, '');
}

/** `domain` is one of `list` or a subdomain of one (mx.txt.att.net matches txt.att.net). */
export function domainMatches(domain: string, list: Iterable<string>): string | null {
  const d = domain.toLowerCase();
  for (const raw of list) {
    const entry = raw.toLowerCase();
    if (entry && (d === entry || d.endsWith(`.${entry}`))) return entry;
  }
  return null;
}

let disposable: Set<string> | null = null;
function disposableSet(): Set<string> {
  if (!disposable) {
    disposable = new Set(DISPOSABLE_DOMAINS_TEXT.split('\n').map((s) => s.trim()).filter(Boolean));
  }
  return disposable;
}

/** Number of built-in throw-away domains (shown in the admin). */
export function disposableDomainCount(): number {
  return disposableSet().size;
}

/** The listed throw-away domain `domain` belongs to (itself or a parent), or null. */
export function disposableMatch(domain: string): string | null {
  const set = disposableSet();
  const parts = domain.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (set.has(candidate)) return candidate;
  }
  return null;
}

export type DomainRulePolicy = {
  MAIL_BLOCKED_DOMAINS: string[];
  MAIL_BLOCK_DISPOSABLE: boolean;
  MAIL_ALLOWED_DOMAINS: string[];
};

export type DomainBlock = { kind: 'blocked' | 'disposable'; domain: string; matched: string; message: string };

/**
 * Why no e-mail may go to `addr` because of its domain, or null. Pure.
 * The message is safe to show to the visitor (it says nothing about accounts).
 */
export function domainBlock(addr: string, policy: DomainRulePolicy): DomainBlock | null {
  const domain = emailDomain(addr);
  if (!domain) return null;
  const blocked = domainMatches(domain, policy.MAIL_BLOCKED_DOMAINS);
  if (blocked) {
    return {
      kind: 'blocked',
      domain,
      matched: blocked,
      message: `We can’t send e-mail to ${domain} addresses. Please use your own work or personal e-mail address.`,
    };
  }
  if (policy.MAIL_BLOCK_DISPOSABLE && !domainMatches(domain, policy.MAIL_ALLOWED_DOMAINS)) {
    const hit = disposableMatch(domain);
    if (hit) {
      return {
        kind: 'disposable',
        domain,
        matched: hit,
        message: `Throw-away e-mail addresses (${domain}) can’t be used. Please use your own work or personal e-mail address.`,
      };
    }
  }
  return null;
}

// ── Limits for anonymous triggers ───────────────────────────────────────────

export type LimitPolicy = {
  MAIL_ADDRESS_COOLDOWN_SEC: number;
  MAIL_ADDRESS_MAX_PER_DAY: number;
  MAIL_DOMAIN_MAX_PER_HOUR: number;
  MAIL_DOMAIN_CAP_EXEMPT: string[];
  MAIL_ANON_MAX_PER_HOUR: number;
};

export type LimitKind = 'cooldown' | 'day' | 'domain' | 'hour';
export type LimitCounts = { cooldown: number; day: number; domain: number; hour: number };

/** Which limit `counts` (e-mails already sent in each window) has reached, or null. Pure. */
export function limitReached(counts: LimitCounts, policy: LimitPolicy, domain: string): LimitKind | null {
  if (policy.MAIL_ADDRESS_COOLDOWN_SEC > 0 && counts.cooldown >= 1) return 'cooldown';
  if (counts.day >= policy.MAIL_ADDRESS_MAX_PER_DAY) return 'day';
  if (!domainMatches(domain, policy.MAIL_DOMAIN_CAP_EXEMPT) && counts.domain >= policy.MAIL_DOMAIN_MAX_PER_HOUR) return 'domain';
  if (counts.hour >= policy.MAIL_ANON_MAX_PER_HOUR) return 'hour';
  return null;
}

/** Visitor-facing text for a reached limit. */
export function limitMessage(kind: LimitKind, retryAfterSec: number): string {
  switch (kind) {
    case 'cooldown': {
      const s = Math.max(1, retryAfterSec);
      const wait = s >= 120 ? `${Math.ceil(s / 60)} minutes` : `${s} second${s === 1 ? '' : 's'}`;
      return `We just sent an e-mail to this address. You can ask for another one in ${wait}.`;
    }
    case 'day':
      return 'We already sent several e-mails to this address today. Please check your inbox and spam folder, or try again tomorrow.';
    default:
      return 'We’re receiving an unusual number of requests right now, so this e-mail was not sent. Please try again later or contact support.';
  }
}

export const SUPPRESSED_MESSAGE =
  'E-mail to this address was rejected by its mail server before, so we no longer send to it. Check the address for typos, or use another one.';

// ── Bounces ─────────────────────────────────────────────────────────────────

/**
 * A permanent rejection of the RECIPIENT (not of our login, sender or
 * content): a 5xx reply to RCPT TO, or a 5xx carrying the "bad destination
 * mailbox" enhanced status 5.1.x / 5.2.1. Policy rejections (5.7.x — relay
 * denied, not authenticated) say nothing about the address and would
 * suppress every recipient, so they never count. Pure.
 */
export function isPermanentRecipientFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { responseCode?: unknown; command?: unknown; response?: unknown; message?: unknown };
  const code = typeof e.responseCode === 'number' ? e.responseCode : Number(/^\s*(5\d\d)\b/.exec(String(e.response ?? ''))?.[1]);
  if (!(code >= 500 && code < 600)) return false;
  const text = `${String(e.response ?? '')} ${String(e.message ?? '')}`;
  if (/\b5\.7\.\d{1,3}\b/.test(text)) return false;
  if (/\b5\.1\.\d{1,3}\b|\b5\.2\.1\b/.test(text)) return true;
  if (e.command !== 'RCPT TO') return false;
  return /user unknown|no such (user|mailbox|recipient)|mailbox (unavailable|not found|disabled)|does not exist|recipient (address )?rejected|invalid recipient|unknown (recipient|user)|undeliverable/i.test(text);
}
