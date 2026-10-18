/**
 * Pure support-ticket rules: SLA hours and business hours, triage keywords,
 * order ownership, the reopen window, attachment lists and the "too many
 * requests" text. No I/O and no settings reads — callers pass the configured
 * values (./policy.ts reads them from Admin → Settings → Support). Safe to
 * import anywhere, including the settings registry. Unit tests: rules.test.ts.
 */

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'VIP'] as const;

/** Statuses where support owes the next reply (the SLA clock runs). */
const AWAITING_SUPPORT = new Set(['OPEN', 'WAITING_ON_SUPPORT']);
export function isAwaitingSupport(status: string): boolean {
  return AWAITING_SUPPORT.has(status);
}

// ── SLA hours per priority ───────────────────────────────────────────────────

/** "VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72" → { VIP: 2, … }. Bad pairs are skipped; NORMAL falls back to 24. */
export function parseSlaHours(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw || '').split(',')) {
    const m = /^\s*(VIP|URGENT|HIGH|NORMAL|LOW)\s*:\s*(\d{1,4})\s*$/i.exec(part);
    if (m) out[m[1].toUpperCase()] = Number(m[2]);
  }
  if (out.NORMAL == null) out.NORMAL = 24;
  return out;
}

export function slaHoursProblem(v: string): string | null {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = parts.every((p) => /^(VIP|URGENT|HIGH|NORMAL|LOW):\d{1,4}$/.test(p)) && parts.some((p) => p.startsWith('NORMAL:'));
  return ok ? null : 'use PRIORITY:hours pairs, e.g. VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72 (NORMAL is required).';
}

// ── Business hours ───────────────────────────────────────────────────────────

/** Open windows per weekday (index 0 = Sunday … 6 = Saturday), in minutes after local midnight. */
export type WeekSchedule = Array<Array<[number, number]>>;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function dayIndex(name: string): number {
  return DAY_NAMES.indexOf(name.slice(0, 3).toLowerCase());
}

function clockMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

type ParsedHours = { schedule: WeekSchedule | null; problem: string | null };

function parseHours(raw: string): ParsedHours {
  const text = (raw || '').trim();
  if (!text) return { schedule: null, problem: null };
  const schedule: WeekSchedule = [[], [], [], [], [], [], []];
  for (const seg of text.split(/[;,\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{3,9})(?:\s*-\s*([A-Za-z]{3,9}))?\s+(.+)$/.exec(seg);
    const from = m ? dayIndex(m[1]) : -1;
    const to = m ? (m[2] ? dayIndex(m[2]) : from) : -1;
    if (!m || from < 0 || to < 0) {
      return { schedule: null, problem: `“${seg}” — start each part with a day or a day range, e.g. Mon-Fri 09:00-17:00.` };
    }
    const windows: Array<[number, number]> = [];
    for (const range of m[3].replace(/\s*-\s*/g, '-').trim().split(/\s+/)) {
      const r = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(range.trim());
      const start = r ? clockMinutes(r[1]) : null;
      const end = r ? clockMinutes(r[2]) : null;
      if (start === null || end === null || end <= start) {
        return { schedule: null, problem: `“${seg}” — times are HH:MM-HH:MM with the end after the start, e.g. 09:00-17:00.` };
      }
      windows.push([start, end]);
    }
    for (let d = from, n = 0; n < 7; d = (d + 1) % 7, n++) {
      schedule[d].push(...windows);
      if (d === to) break;
    }
  }
  for (const day of schedule) day.sort((a, b) => a[0] - b[0]);
  return { schedule, problem: null };
}

/** "Mon-Fri 09:00-17:00, Sat 10:00-13:00" → open windows per weekday; null when empty (round the clock). */
export function parseBusinessHours(raw: string): WeekSchedule | null {
  const parsed = parseHours(raw);
  return parsed.problem ? null : parsed.schedule;
}

export function businessHoursProblem(v: string): string | null {
  return parseHours(v).problem;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** Weekday (0 = Sunday) and minutes after midnight of `at` on the wall clock of `timeZone` (UTC when unknown). */
export function localClock(at: Date, timeZone: string): { weekday: number; minutes: number } {
  let f = clockFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    clockFormats.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { weekday: dayIndex(parts.weekday ?? 'sun'), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/**
 * `from` plus `hours` of support time. Without a schedule the clock runs round
 * the clock; with one it only runs inside the business hours (wall clock of
 * `timeZone`), so a ticket that arrives on Friday evening is due on Monday.
 */
export function addSupportHours(from: Date, hours: number, schedule: WeekSchedule | null, timeZone: string): Date {
  if (!schedule || !schedule.some((d) => d.length > 0)) return new Date(from.getTime() + hours * 3600e3);
  let remaining = Math.max(0, Math.round(hours * 60));
  let t = from.getTime();
  for (let guard = 0; remaining > 0 && guard < 5000; guard++) {
    const { weekday, minutes } = localClock(new Date(t), timeZone);
    const today = schedule[weekday];
    const open = today.find(([s, e]) => minutes >= s && minutes < e);
    if (open) {
      const step = Math.min(remaining, open[1] - minutes);
      t += step * 60_000;
      remaining -= step;
      continue;
    }
    // Closed: jump to the next opening today, else to (about) local midnight.
    const next = today.find(([s]) => s > minutes);
    t += (next ? next[0] - minutes : 24 * 60 - minutes) * 60_000;
  }
  return new Date(t);
}

// ── Triage ───────────────────────────────────────────────────────────────────

/** A whole-word, case-insensitive matcher for a keyword list; null for an empty list. */
export function keywordMatcher(words: readonly string[]): RegExp | null {
  const list = words.map((w) => w.trim()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

export interface TriageInput {
  text: string;
  /** Paid lifetime value of the signed-in customer (cents); 0 for guests. */
  lifetimeCents: number;
  /** Auto-VIP from this paid value (cents); 0 = off. */
  vipThresholdCents: number;
  urgentWords: readonly string[];
  highWords: readonly string[];
  /** Age in hours of the linked order while it is unpaid; null when none / paid. */
  unpaidOrderAgeHours: number | null;
  /** An unpaid linked order older than this makes the ticket HIGH; 0 = off. */
  unpaidHighAfterHours: number;
}

/**
 * Initial priority of a new ticket, in order of precedence: VIP customer,
 * urgent words (fraud, chargeback …), high words (damaged, refund …), an
 * unpaid linked order older than the threshold; otherwise NORMAL.
 */
export function initialPriority(p: TriageInput): 'VIP' | 'URGENT' | 'HIGH' | 'NORMAL' {
  if (p.vipThresholdCents > 0 && p.lifetimeCents >= p.vipThresholdCents) return 'VIP';
  if (keywordMatcher(p.urgentWords)?.test(p.text)) return 'URGENT';
  if (keywordMatcher(p.highWords)?.test(p.text)) return 'HIGH';
  if (p.unpaidHighAfterHours > 0 && p.unpaidOrderAgeHours !== null && p.unpaidOrderAgeHours > p.unpaidHighAfterHours) return 'HIGH';
  return 'NORMAL';
}

// ── Orders mentioned in a ticket ─────────────────────────────────────────────

const ORDER_NO = /L2D-\d{4}-[A-Z0-9]{6}/gi;
const PROFORMA_NO = /PRO-\d{4}-[A-Z0-9]{6}/gi;

function uniqueUpper(matches: RegExpMatchArray | null): string[] {
  return Array.from(new Set((matches ?? []).map((m) => m.toUpperCase())));
}

/** Order numbers (L2D-YYYY-XXXXXX) mentioned in a text, upper-cased, first mention first. */
export function mentionedOrderNumbers(text: string): string[] {
  return uniqueUpper(text.match(ORDER_NO));
}

/** Quote proforma references (PRO-YYYY-XXXXXX) mentioned in a text. */
export function mentionedProformaNumbers(text: string): string[] {
  return uniqueUpper(text.match(PROFORMA_NO));
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether an order (or quote request) belongs to the ticket's customer: the
 * same account, or the ticket e-mail is the order's account / invoice e-mail.
 * A number typed into a ticket proves nothing on its own.
 */
export function belongsToCustomer(
  record: { ownerId: string | null; emails: Array<string | null | undefined> },
  customer: { userId: string | null; email: string | null | undefined },
): boolean {
  if (customer.userId && record.ownerId && record.ownerId === customer.userId) return true;
  return record.emails.some((e) => sameAddress(e, customer.email));
}

// ── Customer replies, reopen window ──────────────────────────────────────────

export interface CustomerReplyRule {
  /** The customer may post a message. */
  canReply: boolean;
  /** Posting reopens the ticket (it is resolved, closed or archived). */
  reopens: boolean;
  /** Last moment a resolved / closed ticket can be reopened; null otherwise. */
  reopenUntil: Date | null;
}

/**
 * What a customer may do on a ticket. Spam is never answerable. A resolved or
 * closed ticket reopens on a reply for `reopenDays` after its last change
 * (closing it, or a later staff action — so the customer gets at least that
 * long); after that the customer opens a new ticket.
 */
export function customerReplyRule(
  t: { status: string; updatedAt: Date; archivedAt?: Date | null },
  reopenDays: number,
  now: Date = new Date(),
): CustomerReplyRule {
  if (t.status === 'SPAM') return { canReply: false, reopens: false, reopenUntil: null };
  if (t.status === 'RESOLVED' || t.status === 'CLOSED') {
    const reopenUntil = new Date(t.updatedAt.getTime() + Math.max(0, reopenDays) * 86400e3);
    return { canReply: now.getTime() < reopenUntil.getTime(), reopens: true, reopenUntil };
  }
  return { canReply: true, reopens: !!t.archivedAt, reopenUntil: null };
}

/**
 * SLA after a customer message. The clock (re)starts when the ball was with
 * the customer — staff wrote last, the ticket was waiting on the customer,
 * resolved or closed, or no deadline was running. A second message while we
 * already owe a reply keeps the running deadline (the oldest unanswered
 * message sets it), so a nudge never hides an overdue ticket.
 */
export function slaAfterCustomerMessage(
  t: { status: string; dueAt: Date | null; lastReplyByStaff: boolean },
): 'restart' | 'keep' {
  return isAwaitingSupport(t.status) && !t.lastReplyByStaff && t.dueAt ? 'keep' : 'restart';
}

// ── Attachments ──────────────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 5;

function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** A file name safe to store and show: no path, no control characters, bounded. */
export function cleanFileName(name: unknown, fallback: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const flat = base.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return (flat || fallback).slice(0, 120);
}

/**
 * Attachment URLs (JSON array, or an array) and their original names,
 * index-aligned. Only the auth-gated proxy URL is accepted — a raw S3 or
 * /media/ URL would bypass the access check. At most five.
 */
export function parseAttachmentList(urlsRaw: unknown, namesRaw?: unknown): { urls: string[]; names: string[] } {
  const names = jsonArray(namesRaw);
  const urls: string[] = [];
  const outNames: string[] = [];
  jsonArray(urlsRaw).forEach((u, i) => {
    if (typeof u !== 'string' || !u.startsWith('/api/support-attachment/') || urls.length >= MAX_ATTACHMENTS) return;
    if (urls.includes(u)) return;
    urls.push(u);
    outNames.push(cleanFileName(names[i], u.split('/').pop() || 'file'));
  });
  return { urls, names: outNames };
}

// ── Messages ─────────────────────────────────────────────────────────────────

/** "Too many requests — try again in N minutes." for a limit that resets at `resetAt`. */
export function tooManyRequestsMessage(resetAt: Date, now: Date = new Date()): string {
  const min = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 60_000));
  return `Too many requests — try again in ${min} minute${min === 1 ? '' : 's'}.`;
}

/** "jane.doe@lab.com" → "j•••@lab.com" (shown to whoever holds an old link). */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}
