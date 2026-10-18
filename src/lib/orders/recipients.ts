import { isDeliverableEmail } from '@/lib/email-address';
import { settingBool, settingString } from '@/lib/settings';

/**
 * Who receives an order's documents (proforma, invoice, credit note) — one
 * rule for every mail, the same as sendOrderInvoice (lib/orders/internal.ts):
 * the accounts-payable address the buyer gave (Order.invoiceEmail, for older
 * orders the e-mail in their billing details) gets the document; the account
 * that ordered gets a copy when it is a different address and
 * INVOICE_EMAIL_CC_ACCOUNT is on. Without an AP address, the account e-mail.
 * Read after ensureSettingsLoaded().
 */

export interface DocumentRecipientsInput {
  /** Order.invoiceEmail (accounts payable, from checkout or the acceptance step). */
  invoiceEmail?: string | null;
  /** The e-mail in the order's billing details (Order.billingAddress.email). */
  billingEmail?: string | null;
  /** The buyer's account e-mail. */
  accountEmail: string;
}

export interface DocumentRecipients {
  to: string;
  /** Copies (the account e-mail), never the `to` address again. */
  cc: string[];
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanEmail(v: string | null | undefined): string | null {
  const e = (v ?? '').trim();
  return e && EMAIL.test(e) ? e : null;
}

/** The e-mail stored in an order's billingAddress JSON, or null. */
export function billingEmailOf(billingAddress: unknown): string | null {
  if (!billingAddress || typeof billingAddress !== 'object') return null;
  const email = (billingAddress as Record<string, unknown>).email;
  return typeof email === 'string' ? cleanEmail(email) : null;
}

/**
 * `ccAccount` defaults to the INVOICE_EMAIL_CC_ACCOUNT setting (“Also send
 * invoices to the account email”).
 */
export function documentRecipients(
  input: DocumentRecipientsInput,
  opts: { ccAccount?: boolean } = {},
): DocumentRecipients {
  const account = input.accountEmail.trim();
  const ap = cleanEmail(input.invoiceEmail) ?? cleanEmail(input.billingEmail);
  if (!ap) return { to: account, cc: [] };
  const ccAccount = opts.ccAccount ?? settingBool('INVOICE_EMAIL_CC_ACCOUNT');
  const different = !!account && ap.toLowerCase() !== account.toLowerCase();
  return { to: ap, cc: ccAccount && different ? [account] : [] };
}

/**
 * Staff inbox for uploaded payment receipts: PAYMENTS_INBOX_EMAIL, else the
 * billing inbox (COMPANY_EMAIL). Null when neither is a deliverable address.
 */
export function paymentsInboxAddress(): string | null {
  for (const key of ['PAYMENTS_INBOX_EMAIL', 'COMPANY_EMAIL']) {
    const addr = settingString(key).trim();
    if (addr && isDeliverableEmail(addr)) return addr;
  }
  return null;
}
