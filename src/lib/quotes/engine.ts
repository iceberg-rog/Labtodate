import { prisma } from '@/lib/db';
import { determineVat, type VatDecision, type VatLineInput } from '@/lib/tax/determine';
import { loadCountryFacts, loadTaxSettings } from '@/lib/tax/settings';
import { checkVatId, type VatIdCheckResult } from '@/lib/tax/vies';
import { parseVatId } from '@/lib/tax/vatid';
import { checkCountry, type CountryDecision } from '@/lib/compliance/country';
import type { OrderDetails } from '@/lib/orders/details';
import type { OfferVatBasis } from './pricing';

/**
 * Server-internal VAT decisions for quote offers and quote orders. NOT a
 * 'use server' module (its exports take arbitrary input and check no session):
 * import it only from server actions / route handlers.
 *
 * One rule set for everything: the VAT engine (lib/tax/determine.ts) with the
 * settings of Admin → Settings → Tax & VAT, the CountryPolicy table and a VIES
 * check of the buyer's VAT ID (cached; never inside a DB transaction).
 */

export interface OfferLineSpec {
  goodsCents: number;
  shippingCents: number;
  /** STANDARD | MARGIN — the quoted listing's VAT scheme. */
  scheme?: 'STANDARD' | 'MARGIN' | null;
}

export function offerVatLines(spec: OfferLineSpec): VatLineInput[] {
  const lines: VatLineInput[] = [{ netCents: spec.goodsCents, lineType: 'GOODS', scheme: spec.scheme === 'MARGIN' ? 'MARGIN' : 'STANDARD' }];
  if (spec.shippingCents > 0) lines.push({ netCents: spec.shippingCents, lineType: 'SHIPPING' });
  return lines;
}

export interface VatOutcome {
  decision: VatDecision;
  vatId: VatIdCheckResult | null;
  shipTo: CountryDecision | null;
  billing: CountryDecision | null;
}

/** Decide the VAT for buyer details (+ lines). Makes the VIES call unless `skipVies`. */
export async function decideVat(input: {
  shipToCountry: string | null;
  billingCountry: string | null;
  vatId: string | null;
  isBusiness: boolean;
  lines: VatLineInput[];
  skipVies?: boolean;
}): Promise<VatOutcome> {
  const [settings, countries] = await Promise.all([loadTaxSettings(), loadCountryFacts()]);
  let vatId: VatIdCheckResult | null = null;
  if (input.vatId) {
    if (input.skipVies) {
      const p = parseVatId(input.vatId);
      vatId = p ? { vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', source: 'DISABLED', validationId: null } : null;
    } else {
      vatId = await checkVatId(input.vatId);
    }
  }
  const decision = determineVat(
    {
      shipToCountry: input.shipToCountry,
      billingCountry: input.billingCountry,
      customerKind: input.isBusiness || input.vatId ? 'BUSINESS' : 'UNKNOWN',
      vatId: vatId && vatId.country ? vatId : null,
      lines: input.lines,
    },
    settings,
    countries,
  );
  const [shipTo, billing] = await Promise.all([
    input.shipToCountry ? checkCountry(input.shipToCountry) : Promise.resolve(null),
    input.billingCountry ? checkCountry(input.billingCountry) : Promise.resolve(null),
  ]);
  return { decision, vatId, shipTo, billing };
}

/** VAT for an order's billing + delivery details. */
export async function decideVatForDetails(details: OrderDetails, lines: VatLineInput[], opts: { skipVies?: boolean; isBusiness?: boolean } = {}): Promise<VatOutcome> {
  return decideVat({
    shipToCountry: details.delivery.country,
    billingCountry: details.billing.country,
    vatId: opts.isBusiness === false ? null : details.billing.vatId,
    // Order.customerType (checkout, 7a) when known; else a legal name = a business.
    isBusiness: opts.isBusiness ?? !!details.billing.legalName,
    lines,
    skipVies: opts.skipVies,
  });
}

/**
 * The VAT basis of an offer at SEND time: decided from the buyer's saved
 * billing profile when there is one, otherwise "determined at acceptance".
 * A decision the rules cannot make yet (VIES down → review, unknown country)
 * is also deferred to acceptance — with the reason, never a guessed rate.
 */
export async function offerVatAtSend(buyerUserId: string | null, spec: OfferLineSpec): Promise<{ basis: OfferVatBasis; decision: VatDecision | null }> {
  const profile = buyerUserId
    ? await prisma.billingProfile.findUnique({ where: { userId: buyerUserId }, select: { country: true, vatId: true, legalName: true } })
    : null;
  if (!profile?.country) {
    return {
      basis: { status: 'AT_ACCEPTANCE', country: null, vatId: null, reasons: ['No billing details on file yet — VAT is determined when the buyer enters them at acceptance.'], legalText: null, shippingRateBp: null },
      decision: null,
    };
  }
  const out = await decideVat({
    shipToCountry: null,
    billingCountry: profile.country,
    vatId: profile.vatId,
    isBusiness: !!profile.legalName,
    lines: offerVatLines(spec),
  });
  const d = out.decision;
  if (d.reviewRequired || d.blocked) {
    return {
      basis: { status: 'AT_ACCEPTANCE', country: profile.country, vatId: out.vatId?.vatId ?? profile.vatId, reasons: d.reasons, legalText: null, shippingRateBp: null },
      decision: null,
    };
  }
  return {
    basis: {
      status: 'DECIDED',
      country: profile.country,
      vatId: d.buyerVatIdRequired ? out.vatId?.vatId ?? profile.vatId : profile.vatId,
      reasons: d.reasons,
      legalText: d.legalText,
      shippingRateBp: d.shippingRateBp,
    },
    decision: d,
  };
}

/** Plain-language VAT line for the buyer / staff ("VAT 21% — domestic supply (NL)"). */
export function vatExplanation(d: VatDecision): string {
  return d.reasons.filter((r) => !/^No delivery country yet/.test(r)).join(' ');
}
