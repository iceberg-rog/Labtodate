import { LegalShell, legalContext } from '@/components/site/LegalShell';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { DEFAULT_TERMS_TEXT, renderTermsBlocks } from '@/lib/catalog/texts';
import { loadPriceDisplay } from '@/lib/pricing/server';
import { settingInt, settingString } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service' };

/**
 * The Terms of Service text is a setting (Settings → Documents & legal texts →
 * LEGAL_TERMS_TEXT). Every number in it is a placeholder filled from the
 * setting that rules it — return window, offer validity, payment term, price
 * basis, warranty fallback — so the terms never disagree with the FAQ, the
 * product pages, the documents or the structured data.
 */
export default async function TermsPage() {
  const [c, policy, display] = await Promise.all([legalContext(), getCatalogPolicy(), loadPriceDisplay()]);
  const priceBasis =
    display.mode === 'INCL'
      ? `including VAT (${display.labelIncl})`
      : display.mode === 'BOTH'
        ? 'both excluding and including VAT'
        : `excluding VAT (${display.labelExcl})`;
  const values: Record<string, string> = {
    '{SITE}': c.site,
    '{LEGAL_NAME}': c.legal,
    '{COUNTRY}': c.country ? ` (${c.country})` : '',
    '{RETURN_DAYS}': String(policy.returnWindowDays),
    '{OFFER_VALID_DAYS}': String(settingInt('OFFER_VALID_DAYS', 14)),
    '{PAYMENT_TERM_DAYS}': String(settingInt('PAYMENT_TERM_DAYS', 14)),
    '{PRICE_BASIS}': priceBasis,
    '{WARRANTY_FALLBACK}': policy.warrantyFallbackText,
    '{INSPECTION_REPORT_CLAUSE}': policy.inspectionRequiresReport ? ' and the inspection report is available on the listing' : '',
    '{SHIPPING_SENTENCE}': policy.shippingClaim
      ? `${policy.shippingClaim.replace(/[.\s]+$/, '')}.`
      : 'Packaging, carrier and insurance are as stated on your order or offer.',
  };
  const blocks = renderTermsBlocks(settingString('LEGAL_TERMS_TEXT') || DEFAULT_TERMS_TEXT, values);
  return (
    <LegalShell title="Terms of Service">
      {blocks.map((b, i) =>
        b.kind === 'h2' ? (
          <h2 key={i}>{'text' in b.parts[0] ? b.parts[0].text : ''}</h2>
        ) : (
          <p key={i}>
            {b.parts.map((part, j) =>
              'contact' in part ? (
                <a key={j} href={c.contactHref}>
                  {c.contactLabel}
                </a>
              ) : (
                <span key={j}>{part.text}</span>
              ),
            )}
          </p>
        ),
      )}
    </LegalShell>
  );
}
