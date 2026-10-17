import { PAID_ORDER_STATES } from '@/lib/quotes/offer';

/**
 * Client-safe document helpers (links, labels). The issuing / storage layer is
 * server-only: import it from '@/lib/documents/issue'.
 *
 * Routes (all auth-checked: the order's buyer or an admin with orders:view):
 *   /api/documents/proforma/<orderNumber>/{pdf|preview}     current proforma
 *   /api/documents/invoice/<orderNumber>/{pdf|preview}      the invoice
 *   /api/documents/credit-note/<orderNumber>/{pdf|preview}  latest credit note
 *   /api/documents/doc/<documentNumber>/{pdf|preview}       any document by number
 * `pdf` streams the stored PDF bytes (rendered once at issue time).
 */

export type DocKind = 'proforma' | 'invoice' | 'credit-note';
export type DocRouteKind = DocKind | 'doc';

/** Site-relative link to an order's document (download or clean preview). */
export function documentHref(kind: DocRouteKind, ref: string, format: 'pdf' | 'preview' = 'pdf'): string {
  return `/api/documents/${kind}/${encodeURIComponent(ref)}/${format}`;
}

/** Link to one specific issued document by its number. */
export function documentNumberHref(number: string, format: 'pdf' | 'preview' = 'pdf'): string {
  return documentHref('doc', number, format);
}

export function absoluteDocumentHref(kind: DocRouteKind, ref: string, format: 'pdf' | 'preview' = 'pdf'): string {
  return `${(process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '')}${documentHref(kind, ref, format)}`;
}

/** Has money been captured for this order status (an invoice can exist)? */
export function invoiceAvailable(status: string): boolean {
  return PAID_ORDER_STATES.includes(status) || status === 'REFUNDED';
}

export function docKindLabel(kind: 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE'): string {
  return kind === 'PROFORMA' ? 'Proforma invoice' : kind === 'INVOICE' ? 'Invoice' : 'Credit note';
}
