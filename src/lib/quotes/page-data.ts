import { prisma } from '@/lib/db';
import { settingString } from '@/lib/settings';
import { countryOptions } from '@/lib/compliance/country';
import { orderLineTruthFor } from '@/lib/catalog/order-snapshot';
import { prefillDetails, type DetailsPrefill, type VatIdRule } from '@/lib/orders/details';
import type { CountryOption } from '@/components/orders/OrderDetailsFields';
import type { OfferFormProps } from '@/components/quotes/OfferForm';
import { vatRowTitle, vatTreatmentLabel } from '@/lib/tax/determine';
import { offerVatAtSend, vatStaffExplanation } from './engine';
import { applyMarkup, pctLabel } from './pricing';
import {
  cancelReasons, declineReasons, offerDefaults, requireTermsAcceptance, sellerMarkupBp, sellerPriceRounding, stockReserveOn, termsOfSaleUrl, vatIdRule,
} from './policy';
import { unitAvailability } from './stock';
import type { OfferFormContext } from './offer-view';

/**
 * Server-side data the quote pages need around the offer card / composer
 * (settings defaults, the buyer's VAT basis, supplier proposal, unit
 * availability, the acceptance prefill). Call ensureSettingsLoaded() first.
 */

type SrLite = {
  id: string;
  submittedById: string | null;
  productId: string | null;
  companyName: string | null;
  buyerName: string;
  sellerProposalStatus?: string | null;
  sellerProposalCents?: number | null;
  sellerProposalCurrency?: string | null;
  sellerProposalNote?: string | null;
  sellerProposalTerms?: unknown;
  sellerProposalAt?: Date | null;
  product?: { vatScheme?: 'STANDARD' | 'MARGIN' | null } | null;
};

export async function stockLine(productId: string | null, quoteId: string): Promise<OfferFormProps['stock']> {
  if (!productId) return null;
  const av = await unitAvailability(productId, quoteId);
  if (!av) return { text: 'The listed product no longer exists.', tone: 'bad' };
  const mode = stockReserveOn();
  const when = mode === 'OFFER_SENT' ? 'when the offer is sent' : mode === 'OFFER_ACCEPTED' ? 'when the buyer accepts' : 'when the payment is verified';
  // A revised quantity resizes the hold: up to heldQty + quantity units can be offered.
  if (av.heldByThisQuote) return { text: `Listed unit reserved for this deal: ${av.heldQty} held (${av.quantity} more in stock).`, tone: 'ok' };
  if (av.quantity > 0) return { text: `Listed unit available: ${av.quantity} in stock — reserved ${when}.`, tone: 'ok' };
  const other = av.otherHolds[0];
  return {
    text: `Listed unit NOT available: 0 in stock${other ? ` — reserved for ${other.orderNumber ? `order ${other.orderNumber}` : other.quoteRef ?? 'another deal'}` : ' (sold)'}. ${mode === 'PAYMENT_VERIFIED' ? 'The buyer can still accept; if the unit is still gone when the payment is verified, the order goes on a stock-shortage hold for you to decide refund, backorder or another unit.' : 'An offer can not be accepted until it is back in stock.'}`,
    tone: 'bad',
  };
}

export async function offerFormContextFor(sr: SrLite, mode: 'STAFF' | 'SELLER', recipientLabel: string): Promise<OfferFormContext> {
  const defaults = offerDefaults();
  const scheme = sr.product?.vatScheme ?? null;
  const [vat, truth, stock] = await Promise.all([
    // A preview from STORED VIES evidence: the admin page re-renders every few
    // seconds (AutoRefresh) and must not call VIES / write a VatValidation row
    // each time. Sending the offer checks the VAT ID live (cached).
    mode === 'STAFF'
      ? offerVatAtSend(sr.submittedById, { goodsCents: 100_000, shippingCents: 10_000, scheme, productId: sr.productId, qty: 1 }, { storedViesOnly: true })
      : Promise.resolve(null),
    sr.productId ? orderLineTruthFor([sr.productId]) : Promise.resolve(new Map()),
    stockLine(sr.productId, sr.id),
  ]);
  const notCheckedYet = vat?.vatId?.status === 'NOT_CHECKED' && vat.vatId.source === 'CACHE' ? ' The VAT ID is checked with VIES when you send the offer.' : '';
  let vatProp: OfferFormProps['vat'];
  if (vat?.decision) {
    vatProp = {
      status: 'DECIDED',
      goodsRateBp: vat.decision.rateBp,
      shippingRateBp: vat.decision.shippingRateBp,
      label: `${vatRowTitle(vat.decision)} — ${vatTreatmentLabel(vat.decision.treatment)}`,
      explanation: vatStaffExplanation(vat.decision),
    };
  } else {
    vatProp = { status: 'AT_ACCEPTANCE', explanation: `VAT is decided when the buyer accepts: ${vat?.basis.reasons.join(' ') ?? 'the buyer confirms billing country and VAT ID then.'}${notCheckedYet}` };
  }
  const t = sr.sellerProposalTerms && typeof sr.sellerProposalTerms === 'object' ? (sr.sellerProposalTerms as Record<string, unknown>) : {};
  const proposal: OfferFormProps['proposal'] =
    mode === 'STAFF' && sr.sellerProposalStatus === 'PENDING' && sr.sellerProposalCents != null
      ? {
          costCents: sr.sellerProposalCents,
          currency: sr.sellerProposalCurrency ?? defaults.currency,
          note: sr.sellerProposalNote ?? null,
          leadTime: typeof t.leadTime === 'string' ? t.leadTime : null,
          warranty: typeof t.warranty === 'string' ? t.warranty : null,
          suggestedUnitCents: applyMarkup(sr.sellerProposalCents, sellerMarkupBp(), sellerPriceRounding()),
          markupLabel: `+${pctLabel(sellerMarkupBp())} margin, rounded ${sellerPriceRounding().toLowerCase()}`,
          atISO: (sr.sellerProposalAt ?? new Date()).toISOString(),
        }
      : null;
  const productWarranty = sr.productId ? (truth.get(sr.productId)?.warrantySnapshot ?? null) : null;
  return { mode, recipientLabel, defaults, vat: vatProp, productWarranty, proposal, stock };
}

export interface AcceptContext {
  prefill: DetailsPrefill;
  countries: CountryOption[];
  homeCountry: string;
  vatIdRule: VatIdRule;
  requireTerms: boolean;
  termsUrl: string;
}

export async function acceptContextFor(sr: SrLite, userId: string): Promise<AcceptContext> {
  const [profile, countries] = await Promise.all([
    prisma.billingProfile.findUnique({ where: { userId }, select: { legalName: true, contactName: true, vatId: true, address: true, country: true, phone: true, invoiceEmail: true } }),
    countryOptions(),
  ]);
  return {
    prefill: prefillDetails({ profile, companyName: sr.companyName, buyerName: sr.buyerName }),
    countries,
    homeCountry: settingString('TAX_HOME_COUNTRY') || 'NL',
    vatIdRule: vatIdRule(),
    requireTerms: requireTermsAcceptance(),
    termsUrl: termsOfSaleUrl(),
  };
}

export function declineContext() {
  return { reasons: declineReasons() };
}

export function cancelContext(orderNumber: string) {
  return { orderNumber, reasons: cancelReasons() };
}
