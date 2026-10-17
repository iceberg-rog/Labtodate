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

export function cancelReasons(): string[] {
  return settingList('ORDER_CANCEL_REASONS');
}

export function buyerCanCancelUnpaid(): boolean {
  return settingBool('BUYER_CAN_CANCEL_UNPAID_ORDER');
}

export function requireTermsAcceptance(): boolean {
  return settingBool('OFFER_REQUIRE_TERMS_ACCEPTANCE');
}

export function termsOfSaleUrl(): string {
  return settingString('TERMS_OF_SALE_URL') || '/terms';
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
