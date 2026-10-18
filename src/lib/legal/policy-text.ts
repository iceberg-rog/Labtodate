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
 */

import { renderTermsBlocks } from '@/lib/catalog/texts';
import { privacyMarketingBasis } from '@/lib/settings/page-texts';

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
