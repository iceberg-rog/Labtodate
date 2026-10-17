import { prisma } from '@/lib/db';
import type { SecurityPolicy } from './policy';

/**
 * Persistent counters (Postgres `rate_limit_bucket`) for rate limits and
 * sign-in lockouts. They survive restarts and are shared by every worker;
 * expired rows are purged by {@link purgeExpiredBuckets} (security sweep).
 *
 * Every function degrades to "allowed" with an in-memory counter when the
 * database is unreachable — a DB hiccup must not lock everyone out, and the
 * memory fallback still stops a burst from one client.
 */

type Hit = { count: number; resetAt: Date };

const memory = new Map<string, { count: number; reset: number }>();
function memoryHit(key: string, windowMs: number): Hit {
  const now = Date.now();
  if (memory.size > 10_000) {
    for (const [k, v] of memory) if (v.reset < now) memory.delete(k);
  }
  const b = memory.get(key);
  if (!b || b.reset <= now) {
    memory.set(key, { count: 1, reset: now + windowMs });
    return { count: 1, resetAt: new Date(now + windowMs) };
  }
  b.count += 1;
  return { count: b.count, resetAt: new Date(b.reset) };
}

// Timestamps are `timestamp without time zone` holding UTC (how Prisma writes
// them), so raw SQL must use UTC "now" — plain now() is in the DB session's
// time zone and shifted every window / lock by the UTC offset.

/** Atomically count one hit in a fixed window. */
export async function hitBucket(key: string, windowMs: number): Promise<Hit> {
  const k = key.slice(0, 400);
  try {
    const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
      INSERT INTO "rate_limit_bucket" ("key", "count", "resetAt", "updatedAt")
      VALUES (${k}, 1, timezone('UTC', now()) + ${windowMs} * interval '1 millisecond', timezone('UTC', now()))
      ON CONFLICT ("key") DO UPDATE SET
        "count"     = CASE WHEN "rate_limit_bucket"."resetAt" <= timezone('UTC', now()) THEN 1 ELSE "rate_limit_bucket"."count" + 1 END,
        "resetAt"   = CASE WHEN "rate_limit_bucket"."resetAt" <= timezone('UTC', now()) THEN EXCLUDED."resetAt" ELSE "rate_limit_bucket"."resetAt" END,
        "updatedAt" = timezone('UTC', now())
      RETURNING "count", "resetAt"`;
    return { count: Number(rows[0].count), resetAt: rows[0].resetAt };
  } catch {
    return memoryHit(k, windowMs);
  }
}

/** Current count of a window that hasn't ended (0 when expired or absent). Does not count a hit. */
export async function peekBucket(key: string): Promise<{ count: number; resetAt: Date | null }> {
  try {
    const row = await prisma.rateLimitBucket.findUnique({ where: { key: key.slice(0, 400) }, select: { count: true, resetAt: true } });
    if (!row || row.resetAt <= new Date()) return { count: 0, resetAt: null };
    return { count: row.count, resetAt: row.resetAt };
  } catch {
    return { count: 0, resetAt: null };
  }
}

/** Remaining time of an active lock on `key`, or null. */
export async function activeLock(key: string): Promise<Date | null> {
  try {
    const row = await prisma.rateLimitBucket.findUnique({ where: { key: key.slice(0, 400) }, select: { lockedUntil: true } });
    return row?.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null;
  } catch {
    return null;
  }
}

/**
 * Put `key` under a lock unless it already is one. Each lock in a row doubles
 * (base · 2^n, capped); the chain restarts when the previous lock ended more
 * than 24 h ago. Returns the new lock end, or null when it was already locked
 * (so the caller sends its alert only once per lock).
 */
export async function lockBucket(key: string, baseMinutes: number, maxMinutes: number): Promise<Date | null> {
  const k = key.slice(0, 400);
  try {
    const rows = await prisma.$queryRaw<{ lockedUntil: Date }[]>`
      UPDATE "rate_limit_bucket" SET
        "lockCount" = CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" < timezone('UTC', now()) - interval '24 hours' THEN 1 ELSE "lockCount" + 1 END,
        "lockedUntil" = timezone('UTC', now()) + LEAST(${maxMinutes}::double precision,
            ${baseMinutes}::double precision * power(2, LEAST(20,
              CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" < timezone('UTC', now()) - interval '24 hours' THEN 0 ELSE "lockCount" END))
          ) * interval '1 minute',
        "count" = 0,
        "updatedAt" = timezone('UTC', now())
      WHERE "key" = ${k} AND ("lockedUntil" IS NULL OR "lockedUntil" <= timezone('UTC', now()))
      RETURNING "lockedUntil"`;
    return rows[0]?.lockedUntil ?? null;
  } catch {
    return null;
  }
}

/** Forget counters and locks (successful sign-in, password reset, admin unlock). */
export async function clearBuckets(keys: string[]): Promise<void> {
  try {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: keys.map((k) => k.slice(0, 400)) } } });
  } catch {
    /* best effort */
  }
  for (const k of keys) memory.delete(k);
}

/** Delete every bucket whose key starts with `prefix` (e.g. all locks of one account). */
export async function clearBucketsByPrefix(prefix: string): Promise<number> {
  try {
    const r = await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: prefix } } });
    return r.count;
  } catch {
    return 0;
  }
}

/** TTL cleanup: windows over for a day and no lock in its 24 h memory period. */
export async function purgeExpiredBuckets(): Promise<number> {
  const r = await prisma.$executeRaw`
    DELETE FROM "rate_limit_bucket"
    WHERE "resetAt" < timezone('UTC', now()) - interval '1 day'
      AND ("lockedUntil" IS NULL OR "lockedUntil" < timezone('UTC', now()) - interval '1 day')`;
  return Number(r);
}

// ── Sign-in brute-force protection ─────────────────────────────────────────

const norm = (email: string) => email.trim().toLowerCase();
export const signInKeys = {
  ip: (ip: string) => `signin:ip:${ip}`,
  accountIp: (email: string, ip: string) => `signin:acctip:${norm(email)}|${ip}`,
  account: (email: string) => `signin:acct:${norm(email)}`,
};

export type SignInBlock = { scope: 'ip' | 'account-ip' | 'account'; until: Date };

/** Minutes until `d`, at least 1. */
export function minutesUntil(d: Date): number {
  return Math.max(1, Math.ceil((d.getTime() - Date.now()) / 60_000));
}

/**
 * Before a password sign-in: is it blocked? Only WRONG passwords count
 * towards the per-IP limit (recordSignInFailure), so a whole campus signing
 * in correctly behind one address is never throttled.
 */
export async function checkSignIn(policy: SecurityPolicy, email: string, ip: string): Promise<SignInBlock | null> {
  const ipFails = await peekBucket(signInKeys.ip(ip));
  if (ipFails.resetAt && ipFails.count >= policy.IP_SIGNIN_LIMIT_PER_15MIN) return { scope: 'ip', until: ipFails.resetAt };
  if (!email) return null;
  const [acctIp, acct] = await Promise.all([activeLock(signInKeys.accountIp(email, ip)), activeLock(signInKeys.account(email))]);
  if (acctIp) return { scope: 'account-ip', until: acctIp };
  if (acct) return { scope: 'account', until: acct };
  return null;
}

/** A wrong password. Returns the lock it triggered (once per lock), if any. */
export async function recordSignInFailure(policy: SecurityPolicy, email: string, ip: string): Promise<SignInBlock | null> {
  await hitBucket(signInKeys.ip(ip), 15 * 60_000);
  if (!email) return null;
  const [perIp, perAcct] = await Promise.all([
    hitBucket(signInKeys.accountIp(email, ip), policy.LOGIN_FAIL_WINDOW_MIN * 60_000),
    hitBucket(signInKeys.account(email), 60 * 60_000),
  ]);
  if (perAcct.count >= policy.LOGIN_MAX_FAILS_PER_ACCOUNT) {
    const until = await lockBucket(signInKeys.account(email), policy.LOCKOUT_BASE_MINUTES, policy.LOCKOUT_MAX_MINUTES);
    if (until) return { scope: 'account', until };
  }
  if (perIp.count >= policy.LOGIN_MAX_FAILS_PER_ACCOUNT_IP) {
    const until = await lockBucket(signInKeys.accountIp(email, ip), policy.LOCKOUT_BASE_MINUTES, policy.LOCKOUT_MAX_MINUTES);
    if (until) return { scope: 'account-ip', until };
  }
  return null;
}

/** Correct password: the failure counters for this account start over. */
export async function recordSignInSuccess(email: string, ip: string): Promise<void> {
  await clearBuckets([signInKeys.accountIp(email, ip), signInKeys.account(email)]);
}

/** Password reset (proves the mailbox): lift every pause on the account. */
export async function clearAccountSignInLocks(email: string): Promise<void> {
  await clearBucketsByPrefix(`signin:acctip:${norm(email)}|`);
  await clearBuckets([signInKeys.account(email)]);
}

/** Message shown on a blocked attempt. */
export function signInBlockMessage(b: SignInBlock): string {
  const mins = minutesUntil(b.until);
  const when = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minute${mins === 1 ? '' : 's'}`;
  if (b.scope === 'ip') {
    return `Too many sign-in attempts from your network. Please try again in ${when}.`;
  }
  return `Too many wrong passwords for this account${b.scope === 'account-ip' ? ' from your network' : ''}. Password sign-in is paused for ${when} — or reset your password with “Forgot password” to get in right away.`;
}

// ── Generic "N per window" limiter ─────────────────────────────────────────

/** Count a hit; returns whether it is within `max` and when the window ends. */
export async function allowHit(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: Date; count: number }> {
  const h = await hitBucket(key, windowMs);
  return { allowed: h.count <= max, resetAt: h.resetAt, count: h.count };
}

/**
 * Repeated-failure guard for second-factor / step-up codes: `max` wrong codes
 * per `windowMin` lock the key for `lockMin`. Returns the lock end when this
 * failure triggered it.
 */
export async function recordCodeFailure(key: string, max = 5, windowMin = 15, lockMin = 15): Promise<Date | null> {
  const h = await hitBucket(key, windowMin * 60_000);
  if (h.count >= max) return lockBucket(key, lockMin, lockMin * 8);
  return null;
}
