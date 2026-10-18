import { LegalShell } from '@/components/site/LegalShell';
import { termsOfSale } from '@/lib/quotes/policy';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service' };

/**
 * The Terms of Service text is a setting (Settings → Documents & legal texts →
 * LEGAL_TERMS_TEXT). Every number in it is a placeholder filled from the
 * setting that rules it — return window, offer validity, payment term, price
 * basis, warranty fallback — so the terms never disagree with the FAQ, the
 * product pages, the documents or the structured data. The filling lives in
 * termsOfSale() (lib/quotes/policy.ts): the version a buyer accepts is the hash
 * of exactly this rendered text.
 */
export default async function TermsPage() {
  const t = await termsOfSale();
  return (
    <LegalShell title="Terms of Service">
      {t.blocks.map((b, i) =>
        b.kind === 'h2' ? (
          <h2 key={i}>{'text' in b.parts[0] ? b.parts[0].text : ''}</h2>
        ) : (
          <p key={i}>
            {b.parts.map((part, j) =>
              'contact' in part ? (
                <a key={j} href={t.contactHref}>
                  {t.contactLabel}
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
