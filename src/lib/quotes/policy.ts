import { createHash } from 'node:crypto';
import {
  settingBool,
  settingEnum,
  settingInt,
  settingIntOrNull,
  settingList,
  settingPercentBp,
  settingString,
} from '@/lib/settings';
import { parseSlaHours, type MarkupRounding } from './pricing';
import type { VatIdRule } from '@/lib/orders/details';
import { DEFAULT_TERMS_TEXT } from '@/lib/catalog/texts';

/**
 * Typed reads of the quotes / offers / payment-page settings (Admin → Settings
 * → "Quotes & offers" and "Payments & credit terms"). Call
 * `await ensureSettingsLoaded()` first (sync getters over the hydrated values).
 */

export function offerValidDays(): number {
  return settingInt('OFFER_VALID_DAYS', 14);
}

export function paymentTermDays(): number {
  return settingInt('PAYMENT_TERM_DAYS', 14);
}

export function paymentGraceDays(): number {
  return settingInt('PAYMENT_GRACE_DAYS', 3);
}

export function autoCancelUnpaid(): boolean {
  return settingBool('AUTO_CANCEL_UNPAID');
}

export function paymentReminderDays(): number[] {
  return uniqueDesc(settingList('PAYMENT_REMINDER_DAYS_BEFORE').map(Number));
}

export function offerExpiryReminderDays(): number[] {
  return uniqueDesc(settingList('OFFER_EXPIRY_REMINDER_DAYS').map(Number));
}

function uniqueDesc(ns: number[]): number[] {
  return Array.from(new Set(ns.filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => b - a);
}

export function offerCurrencies(): string[] {
  const list = settingList('OFFER_CURRENCIES').map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
  return list.length ? list : ['EUR'];
}

export function offerIncoterms(): string[] {
  const list = settingList('OFFER_INCOTERMS').map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
  return list.length ? list : ['EXW'];
}

export interface OfferDefaults {
  currency: string;
  currencies: string[];
  shippingCents: number;
  incoterms: string[];
  incoterm: string;
  incotermPlace: string;
  leadTime: string;
  warrantyFallback: string;
  paymentTermDays: number;
  paymentTermsText: string;
  validDays: number;
}

export function offerDefaults(): OfferDefaults {
  const incoterms = offerIncoterms();
  const wanted = settingString('OFFER_DEFAULT_INCOTERM').toUpperCase();
  // Named place: the issuing city, else the city on the last line of the registered address
  // ("2712 LB Zoetermeer" → "Zoetermeer"), so a default EXW never reads just "NL".
  const addrCity = (settingString('COMPANY_ADDRESS').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '')
    .replace(/^\d[\d\s-]*(?:[A-Z]{2}\b)?\s*/, '').trim();
  const city = settingString('COMPANY_CITY') || addrCity;
  const country = settingString('TAX_HOME_COUNTRY');
  const currencies = offerCurrencies();
  return {
    currency: currencies[0],
    currencies,
    shippingCents: Math.max(0, settingInt('OFFER_DEFAULT_SHIPPING_CENTS', 0)),
    incoterms,
    incoterm: incoterms.includes(wanted) ? wanted : incoterms[0],
    incotermPlace: settingString('OFFER_DEFAULT_INCOTERM_PLACE') || [city, country].filter(Boolean).join(', '),
    leadTime: settingString('OFFER_DEFAULT_LEAD_TIME'),
    warrantyFallback: settingString('OFFER_DEFAULT_WARRANTY'),
    paymentTermDays: paymentTermDays(),
    paymentTermsText: settingString('OFFER_PAYMENT_TERMS_TEXT'),
    validDays: offerValidDays(),
  };
}

export function sellerOffersRequireApproval(): boolean {
  return settingBool('SELLER_OFFERS_REQUIRE_APPROVAL');
}

export function sellerMarkupBp(): number {
  return settingPercentBp('SELLER_OFFER_MARKUP_PCT');
}

export function sellerPriceRounding(): MarkupRounding {
  return settingEnum<MarkupRounding>('SELLER_OFFER_PRICE_ROUNDING');
}

export function sellerSeesSellPrice(): boolean {
  return settingBool('SELLER_SEES_SELL_PRICE');
}

export function quoteSlaHours(priority: string): number {
  const map = parseSlaHours(settingString('QUOTE_SLA_HOURS'));
  return map[priority] ?? map.NORMAL ?? 24;
}

export function autoArchiveOnClose(): boolean {
  return settingBool('QUOTE_AUTO_ARCHIVE_ON_CLOSE');
}

export function declineReasons(): string[] {
  return settingList('QUOTE_DECLINE_REASONS');
}

/** Reasons staff pick when closing a request without a deal (QUOTE_CLOSE_REASONS). */
export function closeReasons(): string[] {
  return settingList('QUOTE_CLOSE_REASONS');
}

export type MediationMode = 'MASK_CONTACTS' | 'STAFF_REVIEW' | 'OFF';
/** How supplier messages reach the buyer (Settings → Suppliers → MESSAGE_MEDIATION_MODE). */
export function mediationMode(): MediationMode {
  const m = settingString('MESSAGE_MEDIATION_MODE');
  return m === 'STAFF_REVIEW' || m === 'OFF' ? m : 'MASK_CONTACTS';
}

/** Buyer text when an accepted offer waits for a VAT decision (QUOTE_MSG_VAT_*). */
export function vatReviewBuyerText(kind: 'VIES_UNAVAILABLE' | 'REVIEW'): string {
  return kind === 'VIES_UNAVAILABLE'
    ? settingString('QUOTE_MSG_VAT_ID_UNCHECKED') || 'We could not check your VAT ID with the EU service right now. Your order is placed; we confirm the VAT before asking for payment.'
    : settingString('QUOTE_MSG_VAT_REVIEW') || 'We need to confirm the VAT for these billing details. Your order is placed; we confirm the VAT before asking for payment.';
}

/** Customer mails may invite a reply only when replies reach a person (TRANSACTIONAL_REPLY_TO). */
export function repliesReachUs(): boolean {
  return !!settingString('TRANSACTIONAL_REPLY_TO').trim();
}

export function cancelReasons(): string[] {
  return settingList('ORDER_CANCEL_REASONS');
}

export function buyerCanCancelUnpaid(): boolean {
  return settingBool('BUYER_CAN_CANCEL_UNPAID_ORDER');
}

export function requireTermsAcceptance(): boolean {
  return settingBool('OFFER_REQUIRE_TERMS_ACCEPTANCE');
}

/** Built-in Terms of Sale page (the public terms text, LEGAL_TERMS_TEXT). */
export const DEFAULT_TERMS_OF_SALE_URL = '/legal/terms';

export function termsOfSaleUrl(): string {
  return settingString('TERMS_OF_SALE_URL') || DEFAULT_TERMS_OF_SALE_URL;
}

/** The Terms of Sale link as an absolute URL (mail clients need one). */
export function termsOfSaleHref(siteBase: string): string {
  const u = termsOfSaleUrl();
  return u.startsWith('/') ? `${siteBase}${u}` : u;
}

/**
 * Version of the terms a buyer accepts: sha256 of the Terms text as configured
 * now (Settings → Documents & legal texts → LEGAL_TERMS_TEXT, else the built-in
 * text) — stored on the order with the time and IP of the acceptance.
 */
export function termsTextVersion(): string {
  const text = settingString('LEGAL_TERMS_TEXT') || DEFAULT_TERMS_TEXT;
  return `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')}`;
}

export function requireDetailsBeforePayment(): boolean {
  return settingBool('REQUIRE_DETAILS_BEFORE_PAYMENT');
}

export function emailProformaRevision(): boolean {
  return settingBool('PROFORMA_REVISION_EMAIL');
}

export function verifyTurnaround(): string {
  return settingString('PAYMENT_VERIFY_TURNAROUND');
}

export function creditTermsEnabled(): boolean {
  return settingBool('CREDIT_TERMS_ENABLED');
}

export function creditDefaults(): { termDays: number; limitCents: number } {
  return { termDays: settingInt('CREDIT_DEFAULT_TERM_DAYS', 30), limitCents: Math.max(0, settingInt('CREDIT_DEFAULT_LIMIT_CENTS', 0)) };
}

export type StockReserveOn = 'OFFER_SENT' | 'OFFER_ACCEPTED' | 'PAYMENT_VERIFIED';
export function stockReserveOn(): StockReserveOn {
  return settingEnum<StockReserveOn>('STOCK_RESERVE_ON');
}

/** Hold length for an OPEN offer (OFFER_SENT mode); null = until the offer expires. */
export function openOfferHoldDays(): number | null {
  return settingIntOrNull('RESERVATION_HOLD_DAYS');
}

export function offerExpiredStaffAlert(): boolean {
  return settingBool('OFFER_EXPIRED_STAFF_ALERT');
}

export function paymentOverdueNotice(): boolean {
  return settingBool('PAYMENT_OVERDUE_NOTICE');
}

/** Whether complete billing details include the buyer's VAT ID (owner report 5). */
export function vatIdRule(): VatIdRule {
  return settingEnum<VatIdRule>('DETAILS_VAT_ID_REQUIRED');
}
