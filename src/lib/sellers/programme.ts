import { renderTermsBlocks, type TermsBlock } from '@/lib/catalog/texts';
import { legalIdentity, siteName } from '@/lib/brand/identity';
import { escapeHtml } from '@/lib/email-html';
import { settingBool, settingString } from '@/lib/settings';
import { DEFAULT_SELLER_PAYOUT_TERMS_TEXT, DEFAULT_SELLER_TERMS_TEXT } from '@/lib/settings/page-texts';

/**
 * The supplier programme as the owner configured it (Admin → Settings →
 * Suppliers): whether /seller/pricing is public, how selling through us works
 * and how suppliers are paid. These texts replace the old env-only "8 %
 * commission / payout in 3 business days" claims (D15) — nothing about
 * commission or payout timing is stated unless the owner writes it here.
 * Synchronous: call after `await ensureSettingsLoaded()`.
 */

export interface SellerProgramme {
  isPublic: boolean;
  terms: TermsBlock[];
  payout: TermsBlock[];
  /** Where {CONTACT} points: the support (else company) e-mail, else the contact page. */
  contactHref: string;
  contactLabel: string;
}

export function sellerProgramme(): SellerProgramme {
  const id = legalIdentity();
  const contact = id.supportEmail || id.email;
  const values: Record<string, string> = { '{SITE}': siteName(), '{LEGAL_NAME}': id.displayName };
  return {
    isPublic: settingBool('SELLER_PROGRAMME_PUBLIC'),
    terms: renderTermsBlocks(settingString('SELLER_TERMS_TEXT') || DEFAULT_SELLER_TERMS_TEXT, values),
    payout: renderTermsBlocks(settingString('SELLER_PAYOUT_TERMS_TEXT') || DEFAULT_SELLER_PAYOUT_TERMS_TEXT, values),
    contactHref: contact ? `mailto:${contact}` : '/contact',
    contactLabel: contact || 'our contact page',
  };
}

/** Text blocks as e-mail paragraphs (escaped); `contactHref` must be absolute. */
export function programmeBlocksHtml(blocks: TermsBlock[], contactHref: string, contactLabel: string): string[] {
  return blocks.map((b) => {
    const inner = b.parts
      .map((p) => ('contact' in p ? `<a href="${escapeHtml(contactHref)}">${escapeHtml(contactLabel)}</a>` : escapeHtml(p.text)))
      .join('');
    return b.kind === 'h2' ? `<p style="margin:14px 0 6px;font-weight:700;">${inner}</p>` : `<p style="margin:0 0 12px;">${inner}</p>`;
  });
}

/** Text blocks as plain text. */
export function programmeBlocksText(blocks: TermsBlock[], contactLabel: string): string {
  return blocks.map((b) => b.parts.map((p) => ('contact' in p ? contactLabel : p.text)).join('')).join('\n\n');
}
