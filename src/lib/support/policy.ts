import { settingInt, settingList, settingString } from '@/lib/settings';
import { allowHit } from '@/lib/security/throttle';
import {
  addSupportHours,
  parseBusinessHours,
  parseSlaHours,
  tooManyRequestsMessage,
  type WeekSchedule,
} from './rules';

/**
 * Typed reads of Admin → Settings → Support (src/lib/support/settings-defs.ts).
 * Call `await ensureSettingsLoaded()` first (sync getters over the hydrated
 * values). The rules themselves are pure: ./rules.ts.
 */

/** A list setting written as "none" means an empty list (an empty field falls back to the default). */
function listOrNone(key: string): string[] {
  const list = settingList(key);
  return list.length === 1 && list[0].toLowerCase() === 'none' ? [] : list;
}

/** Topics a customer picks from on the ticket form (the server accepts only these). */
export function supportTopics(): string[] {
  const list = settingList('SUPPORT_TOPICS');
  return list.length ? list : ['General'];
}

/** The configured topic matching `value` (case-insensitive), or null. */
export function matchTopic(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  return supportTopics().find((t) => t.toLowerCase() === v) ?? null;
}

/** "1 business day" — the reply time promised on the support pages; '' when switched off ("none"). */
export function supportReplyPromise(): string {
  const v = settingString('SUPPORT_REPLY_PROMISE').trim();
  return v.toLowerCase() === 'none' ? '' : v;
}

/** The business hours as configured (e.g. "Mon-Fri 09:00-17:00"); '' = round the clock. */
export function supportHoursText(): string {
  return settingString('SUPPORT_BUSINESS_HOURS').trim();
}

export function supportSchedule(): WeekSchedule | null {
  return parseBusinessHours(supportHoursText());
}

/** Time zone of the business hours (Invoicing & numbering → Business time zone). */
export function businessTimeZone(): string {
  return settingString('BUSINESS_TIMEZONE') || 'Europe/Amsterdam';
}

export function ticketSlaHours(priority: string): number {
  const map = parseSlaHours(settingString('TICKET_SLA_HOURS'));
  return map[priority] ?? map.NORMAL;
}

/** Reply deadline for a ticket that waits on support from `from` on (SLA hours, inside the business hours when set). */
export function computeTicketDueAt(from: Date, priority: string): Date {
  return addSupportHours(from, ticketSlaHours(priority), supportSchedule(), businessTimeZone());
}

/** Paid lifetime value (cents) from which a customer's tickets start as VIP; 0 = off. */
export function vipLifetimeCents(): number {
  return Math.max(0, settingInt('SUPPORT_VIP_LIFETIME_CENTS', 0));
}

export function urgentKeywords(): string[] {
  return listOrNone('SUPPORT_URGENT_KEYWORDS');
}

export function highKeywords(): string[] {
  return listOrNone('SUPPORT_HIGH_KEYWORDS');
}

/** A ticket about an order unpaid for longer than this starts as HIGH; 0 = off. */
export function unpaidOrderHighAfterHours(): number {
  return Math.max(0, settingInt('SUPPORT_UNPAID_ORDER_HIGH_HOURS', 24));
}

/** Days a guest's magic link stays valid (renewed by every staff reply). */
export function magicLinkDays(): number {
  return settingInt('SUPPORT_MAGIC_LINK_DAYS', 14);
}

export function magicLinkExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + magicLinkDays() * 86400e3);
}

/** Days a resolved / closed ticket can be reopened by a customer reply. */
export function reopenDays(): number {
  return settingInt('TICKET_REOPEN_DAYS', 14);
}

function rateWindowMs(): number {
  return settingInt('TICKET_RATE_WINDOW_MINUTES', 10) * 60_000;
}

/** New tickets one visitor (address) or account may open per window. */
export function ticketRateLimit(): { max: number; windowMs: number } {
  return { max: settingInt('TICKET_RATE_LIMIT', 5), windowMs: rateWindowMs() };
}

/** Customer replies per account (or guest ticket link) per window. */
export function replyRateLimit(): { max: number; windowMs: number } {
  return { max: settingInt('TICKET_REPLY_RATE_LIMIT', 10), windowMs: rateWindowMs() };
}

/** A support limit was hit; `message` is readable as is ("try again in N minutes"). */
export class SupportLimitError extends Error {}

/** Count one hit on `key`; throws SupportLimitError past `max` per window. */
export async function supportLimit(key: string, limit: { max: number; windowMs: number }): Promise<void> {
  const { allowed, resetAt } = await allowHit(`rl:${key}`, limit.max, limit.windowMs);
  if (!allowed) throw new SupportLimitError(tooManyRequestsMessage(resetAt));
}

/** A date as customers read it in support mails and pages ("18 Oct 2026"). */
export function supportDate(d: Date): string {
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: businessTimeZone() });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
