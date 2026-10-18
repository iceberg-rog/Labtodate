import { prisma } from '@/lib/db';
import { getSecurityPolicy, type SecurityPolicy } from '@/lib/security/policy';
import { allowHit, clearBuckets, hitBucket, peekBucket } from '@/lib/security/throttle';
import {
  bareAddress,
  bypassesGuards,
  domainBlock,
  emailDomain,
  isAnonymousTrigger,
  limitMessage,
  limitReached,
  SUPPRESSED_MESSAGE,
  type EmailTrigger,
  type LimitCounts,
  type LimitKind,
} from './rules';

export * from './rules';

/**
 * Checks every outgoing e-mail before it is handed to the mail server
 * (src/lib/email.ts sendEmail). Order: blocked / throw-away domain →
 * suppressed address → (anonymous triggers only) per-address cooldown and
 * daily cap, per-domain hourly cap, hourly total. Counters live in
 * rate_limit_bucket (atomic, shared by all workers).
 */

export type GuardStatus = 'blocked' | 'suppressed' | 'throttled';
/**
 * What a refusal is about: one address (its wait, daily cap or suppression —
 * telling the visitor would reveal that the address has an account), its
 * domain, or the whole site (hourly total).
 */
export type GuardScope = 'address' | 'domain' | 'site';
export type GuardResult =
  | { ok: true }
  | { ok: false; status: GuardStatus; scope: GuardScope; code: string; reason: string; message: string; retryAfterSec?: number };

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const mailKeys = {
  cooldown: (addr: string) => `mail:cool:${addr}`,
  day: (addr: string) => `mail:day:${addr}`,
  domain: (domain: string) => `mail:dom:${domain}`,
  hour: () => 'mail:hour',
  /** Permanent rejections of one address, counted over 90 days. */
  bounces: (addr: string) => `mail:bounce:${addr}`,
};

/**
 * Suppression rows (table email_suppression, shared with marketing opt-outs)
 * with this scope stop EVERY e-mail to the address, not just offers.
 */
export const SUPPRESS_ALL_SCOPE = 'ALL';

async function isSuppressed(addr: string): Promise<boolean> {
  try {
    const row = await prisma.emailSuppression.findUnique({
      where: { email_scope: { email: addr, scope: SUPPRESS_ALL_SCOPE } },
      select: { email: true },
    });
    return !!row;
  } catch {
    return false;
  }
}

function secondsUntil(d: Date | null): number {
  return d ? Math.max(1, Math.ceil((d.getTime() - Date.now()) / 1000)) : 60;
}

/** Tell super-admins once an hour that the hourly total was reached. */
async function alertHourlyCap(policy: SecurityPolicy, sample: string): Promise<void> {
  if (!policy.MAIL_GUARD_ALERTS) return;
  const { allowed } = await allowHit('alert:mail-hourly-cap', 1, HOUR);
  if (!allowed) return;
  // Imported lazily: alerts → email → email-guard would be a cycle.
  const { alertSuperAdmins } = await import('@/lib/security/alerts');
  await alertSuperAdmins(
    'Hourly limit of visitor e-mails reached',
    [
      `${policy.MAIL_ANON_MAX_PER_HOUR} e-mails that visitors can trigger without signing in (codes, sign-in and reset links, guest-form confirmations) were sent within the hour.`,
      `Further ones are held back until the hour is over (latest refused: ${sample}). Orders, quotes, invoices and staff mail are not affected.`,
      'If this is an attack, the e-mail protection page shows who was mailed; the limits are in Settings → Security.',
    ],
    '/admin/settings/security/email',
  );
}

/** The counters behind the limits (rate_limit_bucket); tests pass an in-memory store. */
export interface MailCounterStore {
  peek(key: string): Promise<{ count: number; resetAt: Date | null }>;
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: Date | null }>;
}
const bucketStore: MailCounterStore = { peek: peekBucket, hit: hitBucket };

export interface GuardOptions {
  /** false: only look, e.g. before an endpoint creates a code that the guard would then hold back. */
  count?: boolean;
  /**
   * Leave the per-address wait out: neither checked nor started. For notices
   * nobody asked for that send the owner on to a reset link, sign-in or
   * sign-up code right away (sign-in paused, already registered, links off,
   * no account): the wait they started held that next e-mail back. The daily,
   * per-domain and hourly limits still apply and count them.
   */
  skipCooldown?: boolean;
  counters?: MailCounterStore;
}

/**
 * May an e-mail with this trigger go to `to` now? Counts it when it may
 * (see {@link GuardOptions}). Never throws.
 */
export async function guardOutgoing(
  to: string,
  trigger: EmailTrigger,
  policyIn?: SecurityPolicy,
  { count = true, skipCooldown = false, counters = bucketStore }: GuardOptions = {},
): Promise<GuardResult> {
  if (bypassesGuards(trigger)) return { ok: true };
  const policy = policyIn ?? (await getSecurityPolicy());
  const addr = bareAddress(to);
  const block = domainBlock(addr, policy);
  if (block) {
    return {
      ok: false,
      status: 'blocked',
      scope: 'domain',
      code: 'EMAIL_DOMAIN_BLOCKED',
      reason: `${block.kind === 'blocked' ? 'blocked domain' : 'throw-away domain'} ${block.matched}`,
      message: block.message,
    };
  }
  if (policy.MAIL_BOUNCE_SUPPRESS_AFTER > 0 && (await isSuppressed(addr))) {
    return { ok: false, status: 'suppressed', scope: 'address', code: 'EMAIL_SUPPRESSED', reason: 'address suppressed after a permanent rejection', message: SUPPRESSED_MESSAGE };
  }
  if (!isAnonymousTrigger(trigger)) return { ok: true };

  const domain = emailDomain(addr);
  const keys = { cooldown: mailKeys.cooldown(addr), day: mailKeys.day(addr), domain: mailKeys.domain(domain), hour: mailKeys.hour() };
  const useCooldown = policy.MAIL_ADDRESS_COOLDOWN_SEC > 0 && !skipCooldown;
  try {
    const [c, d, dm, h] = await Promise.all([
      useCooldown ? counters.peek(keys.cooldown) : Promise.resolve({ count: 0, resetAt: null }),
      counters.peek(keys.day),
      counters.peek(keys.domain),
      counters.peek(keys.hour),
    ]);
    const before: LimitCounts = { cooldown: c.count, day: d.count, domain: dm.count, hour: h.count };
    const resets = { cooldown: c.resetAt, day: d.resetAt, domain: dm.resetAt, hour: h.resetAt };
    let reached: LimitKind | null = limitReached(before, policy, domain);
    if (!reached && count) {
      // Count it, then re-check the atomic counts: two requests racing past
      // the peek both count, and the one over the limit is refused.
      const [hc, hd, hdm, hh] = await Promise.all([
        useCooldown ? counters.hit(keys.cooldown, policy.MAIL_ADDRESS_COOLDOWN_SEC * 1000) : Promise.resolve({ count: 1, resetAt: new Date() }),
        counters.hit(keys.day, DAY),
        counters.hit(keys.domain, HOUR),
        counters.hit(keys.hour, HOUR),
      ]);
      const after: LimitCounts = { cooldown: hc.count - 1, day: hd.count - 1, domain: hdm.count - 1, hour: hh.count - 1 };
      reached = limitReached(after, policy, domain);
      Object.assign(resets, { cooldown: hc.resetAt, day: hd.resetAt, domain: hdm.resetAt, hour: hh.resetAt });
    }
    if (!reached) return { ok: true };
    const retryAfterSec = secondsUntil(resets[reached]);
    if (reached === 'hour') void alertHourlyCap(policy, addr).catch(() => {});
    return {
      ok: false,
      status: 'throttled',
      scope: reached === 'cooldown' || reached === 'day' ? 'address' : reached === 'domain' ? 'domain' : 'site',
      code: reached === 'cooldown' ? 'EMAIL_COOLDOWN' : 'EMAIL_LIMIT',
      reason: { cooldown: 'per-address wait', day: 'per-address daily cap', domain: `per-domain hourly cap (${domain})`, hour: 'hourly total' }[reached],
      message: limitMessage(reached, retryAfterSec),
      retryAfterSec,
    };
  } catch {
    // Counter store unreachable: domain and suppression rules above still
    // applied; don't block the e-mail on a counting failure.
    return { ok: true };
  }
}

/**
 * A permanent recipient rejection (see isPermanentRecipientFailure): count it
 * and suppress the address once MAIL_BOUNCE_SUPPRESS_AFTER is reached. The
 * server's answer goes to the audit log. Returns true when it was suppressed now.
 */
export async function recordPermanentFailure(to: string, detail: string, policyIn?: SecurityPolicy): Promise<boolean> {
  const policy = policyIn ?? (await getSecurityPolicy());
  if (policy.MAIL_BOUNCE_SUPPRESS_AFTER <= 0) return false;
  const address = bareAddress(to);
  try {
    const { count } = await hitBucket(mailKeys.bounces(address), 90 * DAY);
    if (count < policy.MAIL_BOUNCE_SUPPRESS_AFTER) return false;
    const existing = await prisma.emailSuppression.findUnique({
      where: { email_scope: { email: address, scope: SUPPRESS_ALL_SCOPE } },
      select: { email: true },
    });
    if (existing) return false;
    await prisma.emailSuppression.create({ data: { email: address, scope: SUPPRESS_ALL_SCOPE, reason: 'BOUNCE' } });
    await prisma.auditLog
      .create({ data: { actorEmail: 'system', action: 'email.suppressed', target: address, meta: `rejected ${count}× — ${detail}`.slice(0, 1000) } })
      .catch(() => {});
    return true;
  } catch {
    return false; // best effort (a parallel send may have created the row)
  }
}

/** Admin: stop e-mailing an address (e.g. from a bounce report that arrived in the mailbox). */
export async function suppressAddress(to: string): Promise<void> {
  const address = bareAddress(to);
  await prisma.emailSuppression.upsert({
    where: { email_scope: { email: address, scope: SUPPRESS_ALL_SCOPE } },
    create: { email: address, scope: SUPPRESS_ALL_SCOPE, reason: 'ADMIN' },
    update: { reason: 'ADMIN' },
  });
}

/** Admin: send to this address again; also forgets its rejections, wait and daily cap. */
export async function releaseAddress(to: string): Promise<void> {
  const address = bareAddress(to);
  await prisma.emailSuppression.deleteMany({ where: { email: address, scope: SUPPRESS_ALL_SCOPE } });
  await clearBuckets([mailKeys.cooldown(address), mailKeys.day(address), mailKeys.bounces(address)]);
}
