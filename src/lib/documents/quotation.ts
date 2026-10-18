import type { EmailAttachment } from '@/lib/email';

/**
 * Quotation (offer) PDF of a quote, one per offer revision (QuotationDocument:
 * Q-YYYY-NNNNN-rN, non-fiscal). Interface only for now: no PDF is rendered
 * yet, so offer mails carry none and no page links to one — callers check for
 * null / an offer revision before showing anything.
 */

/** The current revision's quotation PDF as a mail attachment, or null when there is none. */
export async function quotationAttachment(sourcingRequestId: string): Promise<EmailAttachment | null> {
  void sourcingRequestId;
  return null;
}

/** Site path of a quote's quotation PDF (the latest revision, or `revision`). */
export function quotationPath(sourcingRequestId: string, revision?: number | null): string {
  const base = `/api/documents/quotation/${encodeURIComponent(sourcingRequestId)}`;
  return revision && revision > 0 ? `${base}?rev=${revision}` : base;
}
