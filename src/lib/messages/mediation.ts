import type { Prisma } from '@prisma/client';

/**
 * Buyer ↔ supplier message mediation (Settings → Suppliers → “Messages between
 * buyers and suppliers”, MESSAGE_MEDIATION_MODE). The site is the only
 * counterparty: contact details never cross between a buyer and a supplier.
 *
 *  - MASK_CONTACTS: e-mail addresses, phone numbers, links, IBANs / long
 *    account numbers and @handles are replaced by “[contact details removed]”.
 *  - STAFF_REVIEW:  the same for buyer messages; every supplier message is
 *    held (masked) until staff release it in Admin → Buyer-supplier threads.
 *  - OFF:           delivered as written.
 * Messages written by staff are never changed. Price mentions and “deal
 * around the platform” wording are not removed but flagged for staff.
 *
 * Pure (no DB, no settings): the callers pass the mode and the site's own
 * hosts, so links to our own listings survive.
 */

export type MediationMode = 'MASK_CONTACTS' | 'STAFF_REVIEW' | 'OFF';
export type MessageAuthorKind = 'BUYER' | 'SUPPLIER' | 'STAFF';
export type ContactKind = 'email' | 'phone' | 'link' | 'iban' | 'handle';
export type MessageFlag = 'price' | 'off-platform';

export const CONTACT_REMOVED = '[contact details removed]';

export const CONTACT_KIND_LABEL: Record<ContactKind, string> = {
  email: 'e-mail address',
  phone: 'phone number',
  link: 'link',
  iban: 'bank account number',
  handle: 'messenger handle',
};
export const FLAG_LABEL: Record<MessageFlag, string> = {
  price: 'mentions a price',
  'off-platform': 'suggests dealing outside the platform',
};

export function mediationMode(raw: string | null | undefined): MediationMode {
  return raw === 'STAFF_REVIEW' || raw === 'OFF' ? raw : 'MASK_CONTACTS';
}

// ── Contact detection ────────────────────────────────────────────────────────

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// “jan (at) biolab (dot) nl”, “jan [at] biolab.nl”, “jan at biolab dot nl”.
const EMAIL_OBFUSCATED =
  /[a-z0-9._%+-]+\s*(?:[([{]\s*at\s*[)\]}]|\s+at\s+(?=[a-z0-9-]+\s+dot\s+))\s*[a-z0-9-]+(?:\s*(?:\.|[([{]\s*dot\s*[)\]}]|\s+dot\s+)\s*[a-z0-9-]+)+/gi;
const LINK_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// Bare domains (“biolab-direct.nl/shop”). Short TLDs that are also everyday
// words (“it”, “to”, “no”, “is”, “us”, “co”) are left out on purpose.
const TLDS =
  'com|net|org|info|biz|io|eu|nl|de|be|fr|uk|es|pt|at|ch|se|dk|fi|pl|cz|sk|hu|ro|bg|gr|ie|lu|lt|lv|ee|si|hr|ca|au|nz|in|cn|jp|ru|ua|tr|me|ly|gl|shop|store|online|site|app|dev|tech|lab|science|bio|health|link|page|email|xyz|top|ai';
const LINK_BARE = new RegExp(
  `(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?:\\/[^\\s<>"')\\]]*)?`,
  'gi',
);
const IBAN_START = /(?<![a-z0-9])([a-z]{2})(\d{2})(?=[ -]?[a-z0-9])/gi;
// Digit groups split by single separators: +31 6 1234 5678, (030) 1234567, 06-12345678.
const PHONE = /(?<![\w+])(?:\+|00)?\(?\d[\d()]*(?:[ .\/-]\(?\d[\d()]*)*/g;
const HANDLE = /(?<![\w@.])@[a-z0-9_][a-z0-9_.]{2,}/gi;
const SERIAL_LABEL =
  /\b(?:serial(?: number| no\.?)?|s\/n|sn|p\/n|part(?: number| no\.?)?|lot|batch|model|cat(?:alog(?:ue)?)?\.?(?: no\.?)?|article(?: no\.?)?|order|invoice|ref(?:erence)?)\s*[:#.]?\s*(?:no\.?\s*)?$/i;

/** Official IBAN length per country (ISO 13616 registry). */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  DO: 28, EE: 20, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19,
  MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19,
  SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};

/** ISO 7064 mod 97-10 check of an IBAN without spaces. */
export function ibanChecksumOk(iban: string): boolean {
  const t = iban.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(t)) return false;
  let rem = 0;
  for (const ch of t.slice(4) + t.slice(0, 4)) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

type Span = { start: number; end: number; kind: ContactKind };

/** IBANs written with or without spaces / dashes. Checksum-valid ones always;
 *  any IBAN-shaped run right after the word “IBAN” as well. */
function ibanSpans(text: string): Span[] {
  const spans: Span[] = [];
  IBAN_START.lastIndex = 0;
  for (let m = IBAN_START.exec(text); m; m = IBAN_START.exec(text)) {
    const start = m.index;
    // Collect up to 34 alphanumerics, allowing single spaces / dashes between them.
    const chars: { c: string; end: number }[] = [];
    let i = start;
    while (i < text.length && chars.length < 34) {
      const c = text[i];
      if (/[a-z0-9]/i.test(c)) {
        chars.push({ c, end: i + 1 });
        i++;
      } else if ((c === ' ' || c === '-') && i + 1 < text.length && /[a-z0-9]/i.test(text[i + 1]) && chars.length > 0) {
        i++;
      } else break;
    }
    // Only countries with a known IBAN length: trying every length on any
    // “AB12…” word would pass the 1-in-97 checksum by chance far too often.
    const known = IBAN_LENGTH[m[1].toUpperCase()];
    let hit: number | null = null;
    if (known && chars.length >= known && ibanChecksumOk(chars.slice(0, known).map((x) => x.c).join(''))) hit = known;
    if (hit === null && /\biban\b[\s:.#-]*$/i.test(text.slice(Math.max(0, start - 12), start)) && chars.length >= 12) {
      hit = Math.min(chars.length, known ?? 34);
    }
    if (hit !== null) {
      spans.push({ start, end: chars[hit - 1].end, kind: 'iban' });
      IBAN_START.lastIndex = chars[hit - 1].end;
    }
  }
  return spans;
}

function phoneSpans(text: string): Span[] {
  const spans: Span[] = [];
  PHONE.lastIndex = 0;
  for (let m = PHONE.exec(text); m; m = PHONE.exec(text)) {
    const s = m[0];
    const digits = s.replace(/\D/g, '').length;
    const intl = s.startsWith('+');
    const prefixed = /^(?:00|0|\()/.test(s);
    const contiguous = /^\d+$/.test(s);
    // “serial 2802001234”, “part no. 5430000018”: equipment numbers, not phones
    // (one starting with 0, 00, + or “(” is still treated as a phone number).
    if (!intl && !prefixed && SERIAL_LABEL.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    if ((intl && digits >= 8) || (prefixed && digits >= 9) || (contiguous && digits >= 10)) {
      spans.push({ start: m.index, end: m.index + s.length, kind: 'phone' });
    }
  }
  return spans;
}

function regexSpans(text: string, re: RegExp, kind: ContactKind, keep?: (match: string) => boolean): Span[] {
  const spans: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let s = m[0];
    // A sentence full stop or comma after a link is not part of it.
    if (kind === 'link') s = s.replace(/[.,;:!?]+$/, '');
    if (!s || (keep && keep(s))) continue;
    spans.push({ start: m.index, end: m.index + s.length, kind });
  }
  return spans;
}

function hostOf(link: string): string {
  const bare = link.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return bare.split(/[/?#:]/)[0].toLowerCase();
}

/** Replace contact details by {@link CONTACT_REMOVED}. `allowHosts`: links to
 *  these hosts (the site itself) are kept. */
export function maskContacts(text: string, opts: { allowHosts?: readonly string[] } = {}): { text: string; removed: ContactKind[] } {
  const allow = new Set((opts.allowHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, '')).filter(Boolean));
  const ownLink = (s: string) => allow.has(hostOf(s));
  // Each pass masks before the next one runs, so a removed e-mail address is
  // not found again as a domain or a handle.
  const passes: ((t: string) => Span[])[] = [
    (t) => regexSpans(t, EMAIL, 'email'),
    (t) => regexSpans(t, EMAIL_OBFUSCATED, 'email'),
    (t) => regexSpans(t, LINK_SCHEME, 'link', ownLink),
    (t) => regexSpans(t, LINK_BARE, 'link', ownLink),
    ibanSpans,
    phoneSpans,
    (t) => regexSpans(t, HANDLE, 'handle'),
  ];
  const removed = new Set<ContactKind>();
  let out = text;
  for (const pass of passes) {
    const spans = pass(out);
    if (spans.length === 0) continue;
    let next = '';
    let at = 0;
    for (const sp of spans) {
      if (sp.start < at) continue;
      next += out.slice(at, sp.start) + CONTACT_REMOVED;
      at = sp.end;
      removed.add(sp.kind);
    }
    out = next + out.slice(at);
  }
  // “+31 6 1234 5678 / 06 1234 5678” → one marker, not two.
  const token = CONTACT_REMOVED.replace(/[[\]]/g, '\\$&');
  out = out.replace(new RegExp(`${token}(?:[\\s,;/|-]*${token})+`, 'g'), CONTACT_REMOVED);
  return { text: out, removed: [...removed] };
}

// ── Staff flags (not removed) ────────────────────────────────────────────────

const PRICE = /(?:[€$£]\s?\d|\b(?:eur|euro|euros|usd|gbp|chf)\s?\d|\d[\d.,']*\s?(?:[€$£]|k€|\b(?:eur|euros?|usd|gbp|chf)\b))/i;
const OFF_PLATFORM = new RegExp(
  [
    'whats\\s?app', 'telegram', 'wechat', 'skype', 'viber', 'signal app',
    '(?:call|ring|text|phone|mail|e-?mail) me', 'contact (?:me|us) (?:directly|at|on|via)',
    '(?:buy|order|deal|pay|purchase)(?: it)? direct(?:ly)?', 'direct (?:price|deal|sale|offer)', 'directly from us',
    'off[- ](?:the[- ])?platform', 'outside (?:the|this) (?:platform|site|website|marketplace)',
    'skip (?:the )?(?:platform|fee|commission|middleman)', 'platform fee', 'without (?:the )?(?:platform|middleman|commission)',
    'bank transfer', 'wire transfer', 'our (?:own )?(?:web ?shop|website|online shop)',
  ].map((p) => `\\b${p}\\b`).join('|'),
  'i',
);

export function messageFlags(text: string): MessageFlag[] {
  const flags: MessageFlag[] = [];
  if (PRICE.test(text)) flags.push('price');
  if (OFF_PLATFORM.test(text)) flags.push('off-platform');
  return flags;
}

export interface MediationResult {
  /** Text to store and deliver (contact details removed when the mode says so). */
  body: string;
  /** STAFF_REVIEW: the message waits for staff release. */
  held: boolean;
  removed: ContactKind[];
  flags: MessageFlag[];
}

/** What happens to one message under the configured mode. */
export function mediateMessage(input: {
  mode: MediationMode;
  author: MessageAuthorKind;
  body: string;
  allowHosts?: readonly string[];
}): MediationResult {
  if (input.author === 'STAFF' || input.mode === 'OFF') {
    return { body: input.body, held: false, removed: [], flags: [] };
  }
  const masked = maskContacts(input.body, { allowHosts: input.allowHosts });
  return {
    body: masked.text,
    held: input.mode === 'STAFF_REVIEW' && input.author === 'SUPPLIER',
    removed: masked.removed,
    flags: messageFlags(input.body),
  };
}

/** Staff-facing summary: “removed: phone number, e-mail address · mentions a price”. */
export function screeningSummary(r: Pick<MediationResult, 'removed' | 'flags'>): string {
  const parts: string[] = [];
  if (r.removed.length) parts.push(`removed: ${r.removed.map((k) => CONTACT_KIND_LABEL[k]).join(', ')}`);
  for (const f of r.flags) parts.push(FLAG_LABEL[f]);
  return parts.join(' · ');
}

// ── Delivery state of a stored Message ───────────────────────────────────────
// Message has no status column: a held or withheld message carries an
// invisible prefix on its body (U+2063, never accepted from user input — see
// sanitizeMessageInput). Held / withheld rows also get readAt set, so the
// unread counters (src/app/app/layout.tsx, src/app/app/page.tsx) skip them.

const MARK = String.fromCharCode(0x2063);
export const HOLD_MARK = MARK;
export const HELD_PREFIX = `${MARK}held${MARK}`;
export const WITHHELD_PREFIX = `${MARK}withheld${MARK}`;

export type DeliveryState = 'DELIVERED' | 'HELD' | 'WITHHELD';

export function deliveryState(body: string): DeliveryState {
  if (body.startsWith(HELD_PREFIX)) return 'HELD';
  if (body.startsWith(WITHHELD_PREFIX)) return 'WITHHELD';
  return 'DELIVERED';
}

/** The text without the state prefix. */
export function messageText(body: string): string {
  if (body.startsWith(HELD_PREFIX)) return body.slice(HELD_PREFIX.length);
  if (body.startsWith(WITHHELD_PREFIX)) return body.slice(WITHHELD_PREFIX.length);
  return body;
}

export function storedBody(state: DeliveryState, text: string): string {
  return state === 'HELD' ? HELD_PREFIX + text : state === 'WITHHELD' ? WITHHELD_PREFIX + text : text;
}

/** Typed text as stored: no state marker, Unix line ends, trimmed. */
export function sanitizeMessageInput(body: string): string {
  return body.split(MARK).join('').replace(/\r\n?/g, '\n').trim();
}

/** Messages a participant may see: their own (any state) and delivered ones. */
export function visibleToParticipant(viewerId: string): Prisma.MessageWhereInput {
  return { OR: [{ authorId: viewerId }, { NOT: { body: { startsWith: HOLD_MARK } } }] };
}
