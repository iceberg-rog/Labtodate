import { permanentRedirect } from 'next/navigation';
import { DEFAULT_TERMS_OF_SALE_URL } from '@/lib/quotes/policy';

/**
 * Offers e-mailed before the Terms link moved linked to /terms, which never
 * existed: answer them with a permanent redirect (308) to the Terms of Sale.
 */
export default function TermsRedirect(): never {
  permanentRedirect(DEFAULT_TERMS_OF_SALE_URL);
}
