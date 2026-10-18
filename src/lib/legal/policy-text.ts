/**
 * The privacy and cookie pages (/legal/privacy, /legal/cookies) render the
 * admin-editable texts PRIVACY_POLICY_TEXT and COOKIE_POLICY_TEXT (Admin →
 * Settings → Site texts & pages; defaults in lib/settings/page-texts.ts). Pure:
 * the pages gather the facts below from the settings and this module turns
 * them into the placeholder values and the blocks to render.
 *
 * Format — the Terms of Service format (renderTermsBlocks) plus links: “## ”
 * starts a heading, an empty line a new paragraph, {CONTACT} becomes the
 * contact link and [link text](/path) a link to a page of this site (other
 * targets stay plain text).
 *
 * No admin AI tool sends personal data (they read supplier web pages and
 * URLs), so no AI provider is named. If one ever does, the policy must name it.
 * Staff notices do (lib/webhooks: names, message excerpts, sign-in alerts), so
 * every chat service an active webhook posts them to is named.
 */

import { renderTermsBlocks } from '@/lib/catalog/texts';
import { DEFAULT_COOKIE_POLICY_DATE, DEFAULT_PRIVACY_POLICY_DATE, privacyMarketingBasis } from '@/lib/settings/page-texts';

/** The only card processor the checkout supports (lib/stripe). */
export const CARD_PAYMENT_PROVIDER = 'Stripe';

/** What the policies state, as configured in the settings. */
export interface PolicyFacts {
  /** Brand name (SITE_NAME). */
  site: string;
  /** Registered company name, else the brand (legalIdentity().displayName). */
  legalName: string;
  /** Registered address lines, the country last (legalIdentity().addressLines). */
  addressLines: string[];
  /** DOC_RETENTION_YEARS. */
  retentionYears: number;
  /** Card payment is offered at checkout or on an order (STRIPE_CARD enabled and configured). */
  cardPayments: boolean;
  /** Security → Marketing e-mail → soft opt-in (MARKETING_SOFT_OPT_IN). */
  marketingSoftOptIn: boolean;
  /** The chat services active webhooks post staff notices to (teamNotificationServices), e.g. ['Slack']. */
  teamNotificationServices: string[];
}

/** WebhookConfig.kind → the service named on the privacy page (lib/webhooks buildPayload sends to these only). */
const WEBHOOK_SERVICE: Record<string, string> = { SLACK: 'Slack', DISCORD: 'Discord', TELEGRAM: 'Telegram' };

/**
 * The chat services that receive the staff notices, from the active webhooks:
 * each known kind once, sorted. A Telegram hook without a chat id sends
 * nothing (buildPayload), so it does not count.
 */
export function teamNotificationServices(hooks: { kind: string; chatId: string | null }[]): string[] {
  return [...new Set(hooks.map(serviceOf).filter((n): n is string => !!n))].sort();
}

function serviceOf(h: { kind: string; chatId: string | null }): string | null {
  const name = WEBHOOK_SERVICE[h.kind];
  return name && (h.kind !== 'TELEGRAM' || h.chatId?.trim()) ? name : null;
}

/**
 * When the last of the named services was added: for each service, its
 * oldest active hook; the latest of those. A second hook of a service that is
 * already named changes nothing on the page. null without hooks.
 */
export function teamNotificationsAddedAt(hooks: { kind: string; chatId: string | null; createdAt: Date }[]): Date | null {
  const first = new Map<string, Date>();
  for (const h of hooks) {
    const name = serviceOf(h);
    const seen = name ? first.get(name) : undefined;
    if (name && (!seen || h.createdAt < seen)) first.set(name, h.createdAt);
  }
  let at: Date | null = null;
  for (const d of first.values()) if (!at || d > at) at = d;
  return at;
}

/** “Slack”, “Discord and Slack”, “Discord, Slack and Telegram”. */
function listOf(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
}

export type PolicyPart = { text: string } | { contact: true } | { text: string; href: string };
export type PolicyBlock = { kind: 'h2' | 'p'; parts: PolicyPart[] };

/** Where {CONTACT} points: the public support e-mail, else the company e-mail, else the contact page. */
export function policyContact(supportEmail: string, companyEmail: string): { href: string; label: string } {
  const email = supportEmail.trim() || companyEmail.trim();
  return email ? { href: `mailto:${email}`, label: email } : { href: '/contact', label: 'our contact page' };
}

/** The registered address as “, <line>, <line>, <country>”; '' when not set. */
export function addressFill(lines: string[]): string {
  const parts = lines.map((l) => l.trim()).filter(Boolean);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

/** Placeholder values of the privacy policy (PRIVACY_POLICY_TOKENS). */
export function privacyPolicyValues(f: PolicyFacts): Record<string, string> {
  return {
    '{SITE}': f.site,
    '{LEGAL_NAME}': f.legalName,
    '{ADDRESS}': addressFill(f.addressLines),
    '{RETENTION_YEARS}': String(f.retentionYears),
    '{CARD_PAYMENTS}': f.cardPayments
      ? ` Card payments: when you pay by card, you enter your card details on the payment page of ${CARD_PAYMENT_PROVIDER}, our payment provider, which receives them together with your e-mail address, the items, the amount and the order number. We never see your full card number.`
      : '',
    '{MARKETING_BASIS}': privacyMarketingBasis(f.marketingSoftOptIn),
    '{TEAM_NOTIFICATIONS}': f.teamNotificationServices.length
      ? ` Team notifications: our staff receive notices about orders, quotes, payments, support tickets and sign-in security in ${listOf(f.teamNotificationServices)}. A notice can include your name or company name, the subject or an excerpt of your message, an order amount, your delivery city and country and, for a sign-in security alert, your e-mail address and IP address; ${f.teamNotificationServices.length > 1 ? 'the providers of these services receive and store' : 'the provider of that service receives and stores'} these notices.`
      : '',
  };
}

/** Placeholder values of the cookie policy (COOKIE_POLICY_TOKENS). */
export function cookiePolicyValues(f: PolicyFacts): Record<string, string> {
  return {
    '{SITE}': f.site,
    '{CARD_PAYMENT_COOKIES}': f.cardPayments
      ? ` When you pay by card, you do so on the payment page of ${CARD_PAYMENT_PROVIDER}, our payment provider, which sets its own cookies there.`
      : '',
  };
}

/** Settings that fill the placeholders and the contact link of both pages (brand, contact, card payment). */
const SHARED_FACT_KEYS = ['SITE_NAME', 'SUPPORT_EMAIL', 'COMPANY_EMAIL', 'PAYMENT_METHODS_ENABLED', 'STRIPE_SECRET_KEY'];

/** Per page: its text setting, the date of its default text and the settings behind what it states. */
export const POLICY_SOURCES = {
  privacy: {
    textKey: 'PRIVACY_POLICY_TEXT',
    defaultDate: DEFAULT_PRIVACY_POLICY_DATE,
    factKeys: [...SHARED_FACT_KEYS, 'COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'COMPANY_COUNTRY', 'DOC_RETENTION_YEARS', 'MARKETING_SOFT_OPT_IN'],
    webhooks: true,
  },
  cookies: { textKey: 'COOKIE_POLICY_TEXT', defaultDate: DEFAULT_COOKIE_POLICY_DATE, factKeys: SHARED_FACT_KEYS, webhooks: false },
} as const;

/**
 * The “Last updated” date of a policy page: when the text in use was written
 * (its Setting row, else the date of the default text) or, if later, the last
 * recorded change of what fills it in (Change history of the text and of the
 * settings behind its placeholders, a webhook added).
 */
export function policyRevisionDate(input: { textUpdatedAt: Date | null; defaultTextDate: Date; changes: (Date | null | undefined)[] }): Date {
  let at = input.textUpdatedAt ?? input.defaultTextDate;
  for (const d of input.changes) if (d && d.getTime() > at.getTime()) at = d;
  return at;
}

/** A path on this site (“/app/orders”), never another site (“//x”, “https://…”). */
function isSitePath(href: string): boolean {
  return /^\/(?![/\\])/.test(href);
}

/** Split a text part into text and [link text](/path) links. */
function withLinks(text: string): PolicyPart[] {
  const out: PolicyPart[] = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [whole, label, href] = m;
    if (!isSitePath(href)) continue; // stays as written
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: label, href });
    at = m.index + whole.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The block without the spaces a fill such as “ Card payments: …” starts a paragraph with. */
function trimEdges(parts: PolicyPart[]): PolicyPart[] {
  const out = parts.map((p) => ({ ...p }));
  const first = out[0];
  const last = out[out.length - 1];
  if (first && 'text' in first) first.text = first.text.trimStart();
  if (last && 'text' in last) last.text = last.text.trimEnd();
  return out.filter((p) => !('text' in p) || p.text);
}

/**
 * The text as headings and paragraphs, placeholders filled. A paragraph that
 * is empty once filled (a placeholder alone on its line that has nothing to
 * say, such as {CARD_PAYMENTS} without card payments) is dropped.
 */
export function renderPolicyBlocks(text: string, values: Record<string, string>): PolicyBlock[] {
  return renderTermsBlocks(text, values)
    .map((b) => ({
      kind: b.kind,
      parts: trimEdges(b.parts.flatMap((p): PolicyPart[] => ('contact' in p ? [p] : b.kind === 'p' ? withLinks(p.text) : [p]))),
    }))
    .filter((b) => b.parts.length > 0);
}
