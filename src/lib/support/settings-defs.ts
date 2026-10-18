import type { SettingDefinitionInput } from '@/lib/settings/defs';
import { businessHoursProblem, slaHoursProblem } from './rules';

/**
 * Admin settings owned by the support-ticket area (group “Support”: topics,
 * SLA per priority, business hours, response-time text, VIP rules, magic-link
 * and reopen periods, rate limits). Registered in the typed settings registry
 * (src/lib/settings/defs.ts spreads this list), so every key gets validation,
 * the .env fallback and the Change history. Read them through ./policy.ts
 * after ensureSettingsLoaded().
 */

const entryList = (maxLen: number, what: string) => (v: string): string | null => {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return `add at least one ${what}.`;
  return parts.some((p) => p.length > maxLen) ? `each ${what} may have at most ${maxLen} characters.` : null;
};

const keywordList = (v: string): string | null => {
  if (v.trim().toLowerCase() === 'none') return null;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.some((p) => p.length > 40)) return 'each word or phrase may have at most 40 characters.';
  return parts.length > 60 ? 'at most 60 words or phrases.' : null;
};

export const SUPPORT_SETTING_DEFS: readonly SettingDefinitionInput[] = [
  // ── What customers see ────────────────────────────────────────────────
  {
    key: 'SUPPORT_TOPICS', label: 'Ticket topics', group: 'Support', type: 'list', preview: '/support',
    default: 'General,Order / delivery,Quote / pricing,Selling,Technical,Billing',
    validate: entryList(60, 'topic'),
    hint: 'The “Topic” choices of the ticket form on /support and /contact, comma-separated; the first one is preselected. Tickets with any other topic are refused. Staff see the topic on every ticket.',
  },
  {
    key: 'SUPPORT_REPLY_PROMISE', label: 'Reply time promised to customers', group: 'Support', type: 'string', preview: '/support', default: '1 business day',
    validate: (v) => (v.length > 60 ? 'at most 60 characters.' : null),
    hint: 'Shown as “Replies within …” on /support, under the ticket form and on the “Ticket received” page. Keep it in line with the reply times below. Write “none” to show no promise.',
  },
  {
    key: 'SUPPORT_BUSINESS_HOURS', label: 'Support business hours', group: 'Support', type: 'string', preview: '/support', optional: true,
    validate: businessHoursProblem,
    hint: 'e.g. “Mon-Fri 09:00-17:00” or “Mon-Thu 08:30-17:00, Fri 08:30-15:00”, in the business time zone (Invoicing & numbering). Set: reply deadlines only count these hours (a ticket on Friday evening is due on Monday) and /support shows them. Empty: deadlines run round the clock.',
  },

  // ── Reply deadlines and triage ────────────────────────────────────────
  {
    key: 'TICKET_SLA_HOURS', label: 'Reply time per priority (hours)', group: 'Support', type: 'list', default: 'VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72',
    validate: slaHoursProblem,
    hint: 'The deadline runs while a ticket waits on your team: from a new ticket, or from the customer’s message after your last reply. A further customer message keeps the running deadline; a staff reply stops it. Overdue tickets are flagged by the SLA check and staff are notified.',
  },
  {
    key: 'SUPPORT_VIP_LIFETIME_CENTS', label: 'VIP from paid orders worth', group: 'Support', type: 'money', default: '5000000', min: 0,
    hint: 'A signed-in customer whose paid orders add up to at least this amount opens tickets as VIP (the tightest reply time). 0 = no automatic VIP. Default 50,000.00.',
  },
  {
    key: 'SUPPORT_URGENT_KEYWORDS', label: 'Words that make a ticket URGENT', group: 'Support', type: 'list',
    default: 'fraud,scam,chargeback,dispute,stolen,hacked,unauthorised,unauthorized',
    validate: keywordList,
    hint: 'Whole words or phrases, comma-separated, found in the subject or message of a new ticket. Write “none” to switch the rule off.',
  },
  {
    key: 'SUPPORT_HIGH_KEYWORDS', label: 'Words that make a ticket HIGH', group: 'Support', type: 'list',
    default: 'missing,lost,never arrived,damaged,broken,wrong item,customs,refund,wrong amount,double charge,invoice wrong,paid twice',
    validate: keywordList,
    hint: 'Like the urgent words, one step lower (delivery and payment problems). Write “none” to switch the rule off.',
  },
  {
    key: 'SUPPORT_UNPAID_ORDER_HIGH_HOURS', label: 'HIGH when the order is unpaid for (hours)', group: 'Support', type: 'int', default: '24', min: 0, max: 720,
    hint: 'A ticket linked to the customer’s own order that has waited for payment longer than this starts as HIGH. 0 = off.',
  },

  // ── Links, reopening, limits ──────────────────────────────────────────
  {
    key: 'SUPPORT_MAGIC_LINK_DAYS', label: 'Guest ticket link valid for (days)', group: 'Support', type: 'int', default: '14', min: 1, max: 365,
    hint: 'Guests follow their ticket through a private link in the e-mails. Every staff reply renews it for this many days; an expired link page lets the guest request a new one by e-mail.',
  },
  {
    key: 'TICKET_REOPEN_DAYS', label: 'Customers can reopen a ticket for (days)', group: 'Support', type: 'int', default: '14', min: 1, max: 365,
    hint: 'When a ticket is resolved or closed the customer is e-mailed; replying on the ticket page within this many days reopens it (back in the Open tab). After that they open a new ticket.',
  },
  {
    key: 'TICKET_RATE_LIMIT', label: 'New tickets per visitor', group: 'Support', type: 'int', default: '5', min: 1, max: 100,
    hint: 'How many tickets one visitor (network address, or account when signed in) can open within the time window below. More gets “Too many requests — try again in N minutes”; the typed text stays in the form. Also caps how often a new link can be requested for one expired guest ticket link.',
  },
  {
    key: 'TICKET_REPLY_RATE_LIMIT', label: 'Customer replies per window', group: 'Support', type: 'int', default: '10', min: 1, max: 200,
    hint: 'How many replies one customer account (or one guest ticket link) can post within the time window below. Each reply notifies your team, so this stops floods.',
  },
  {
    key: 'TICKET_RATE_WINDOW_MINUTES', label: 'Time window for the limits (minutes)', group: 'Support', type: 'int', default: '10', min: 1, max: 1440,
    hint: 'The window of the two limits above.',
  },
];
