import { prisma } from '@/lib/db';
import { buyerVatExplanation, determineVat, type VatDecision, type VatLineInput } from '@/lib/tax/determine';
import { loadCountryFacts, loadTaxSettings } from '@/lib/tax/settings';
import { checkVatId, storedVatIdCheck, type VatIdCheckResult } from '@/lib/tax/vies';
import { parseVatId } from '@/lib/tax/vatid';
import { checkCountry, type CountryDecision } from '@/lib/compliance/country';
import type { OrderDetails } from '@/lib/orders/details';
import type { OfferVatBasis } from './pricing';

export { buyerVatLabel, vatRowTitle } from '@/lib/tax/determine';

/**
 * Server-internal VAT decisions for quote offers and quote orders. NOT a
 * 'use server' module (its exports take arbitrary input and check no session):
 * import it only from server actions / route handlers.
 *
 * One rule set for everything: the VAT engine (lib/tax/determine.ts) with the
 * settings of Admin → Settings → Tax & VAT, the CountryPolicy table and a VIES
 * check of the buyer's VAT ID (cached; never inside a DB transaction). The
 * VIES name is compared with the buyer's legal name. Buyers read
 * vatExplanation() / buyerVatLabel() / vatRowTitle(); staff read
 * vatStaffExplanation().
 */

export interface OfferLineSpec {
  goodsCents: number;
  shippingCents: number;
  /** STANDARD | MARGIN — the quoted listing's VAT scheme. */
  scheme?: 'STANDARD' | 'MARGIN' | null;
  /** The quoted listing (null = a sourced item): a margin-scheme cost is read from it. */
  productId: string | null;
  /** Units on the offer (the purchase cost is per unit). */
  qty?: number;
  /** Purchase cost of the whole goods line; loaded from the listing when undefined. */
  purchaseCostCents?: number | null;
}

/**
 * The engine lines of an offer. A margin-scheme line carries its purchase cost
 * (Product.purchaseCostCents × qty, loaded when not passed): the margin VAT is
 * computed from it, and the engine never reports "no purchase cost" for a
 * unit whose cost is on file.
 */
export async function offerVatLines(spec: OfferLineSpec): Promise<VatLineInput[]> {
  const margin = spec.scheme === 'MARGIN';
  let cost = spec.purchaseCostCents;
  if (margin && cost === undefined && spec.productId) {
    const p = await prisma.product.findUnique({ where: { id: spec.productId }, select: { purchaseCostCents: true } });
    cost = p?.purchaseCostCents != null ? p.purchaseCostCents * Math.max(1, spec.qty ?? 1) : null;
  }
  const lines: VatLineInput[] = [{ netCents: spec.goodsCents, lineType: 'GOODS', scheme: margin ? 'MARGIN' : 'STANDARD', ...(margin ? { purchaseCostCents: cost ?? null } : {}) }];
  if (spec.shippingCents > 0) lines.push({ netCents: spec.shippingCents, lineType: 'SHIPPING' });
  return lines;
}

export interface VatOutcome {
  decision: VatDecision;
  vatId: VatIdCheckResult | null;
  shipTo: CountryDecision | null;
  billing: CountryDecision | null;
}

/**
 * Decide the VAT for buyer details (+ lines). The VAT ID is checked with VIES
 * (cached) unless `skipVies`; `storedViesOnly` uses the stored evidence only —
 * no VIES call, no new evidence row (previews that re-render).
 */
export async function decideVat(input: {
  shipToCountry: string | null;
  billingCountry: string | null;
  vatId: string | null;
  isBusiness: boolean;
  /** The buyer's registered company name (compared with the name VIES returns). */
  buyerLegalName?: string | null;
  lines: VatLineInput[];
  skipVies?: boolean;
  storedViesOnly?: boolean;
}): Promise<VatOutcome> {
  const [settings, countries] = await Promise.all([loadTaxSettings(), loadCountryFacts()]);
  let vatId: VatIdCheckResult | null = null;
  if (input.vatId) {
    if (input.skipVies) {
      const p = parseVatId(input.vatId);
      vatId = p ? { vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', source: 'DISABLED', validationId: null } : null;
    } else {
      vatId = input.storedViesOnly ? await storedVatIdCheck(input.vatId) : await checkVatId(input.vatId);
    }
  }
  const decision = determineVat(
    {
      shipToCountry: input.shipToCountry,
      billingCountry: input.billingCountry,
      customerKind: input.isBusiness || input.vatId ? 'BUSINESS' : 'UNKNOWN',
      vatId: vatId && vatId.country ? vatId : null,
      buyerLegalName: input.buyerLegalName ?? null,
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
    buyerLegalName: details.billing.legalName,
    lines,
    skipVies: opts.skipVies,
  });
}

/**
 * The VAT basis of an offer at SEND time: decided from the buyer's saved
 * billing profile when there is one, otherwise "determined at acceptance".
 * A decision the rules cannot make yet (VIES down → review, unknown country)
 * is also deferred to acceptance — with the reason, never a guessed rate.
 * `storedViesOnly`: the admin composer preview (no live VIES call per render).
 */
export async function offerVatAtSend(
  buyerUserId: string | null,
  spec: OfferLineSpec,
  opts: { storedViesOnly?: boolean } = {},
): Promise<{ basis: OfferVatBasis; decision: VatDecision | null; vatId: VatIdCheckResult | null }> {
  const profile = buyerUserId
    ? await prisma.billingProfile.findUnique({ where: { userId: buyerUserId }, select: { country: true, vatId: true, legalName: true } })
    : null;
  if (!profile?.country) {
    return {
      basis: { status: 'AT_ACCEPTANCE', country: null, vatId: null, reasons: ['No billing details on file yet — VAT is determined when the buyer enters them at acceptance.'], legalText: null, shippingRateBp: null },
      decision: null,
      vatId: null,
    };
  }
  const out = await decideVat({
    shipToCountry: null,
    billingCountry: profile.country,
    vatId: profile.vatId,
    isBusiness: !!profile.legalName,
    buyerLegalName: profile.legalName,
    lines: await offerVatLines(spec),
    storedViesOnly: opts.storedViesOnly,
  });
  const d = out.decision;
  if (d.reviewRequired || d.blocked) {
    return {
      basis: { status: 'AT_ACCEPTANCE', country: profile.country, vatId: out.vatId?.vatId ?? profile.vatId, reasons: d.reasons, legalText: null, shippingRateBp: null },
      decision: null,
      vatId: out.vatId,
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
    vatId: out.vatId,
  };
}

/** Plain-language VAT explanation for the BUYER ("Delivery in NL: VAT 21%.") — never the staff reasons. */
export function vatExplanation(d: VatDecision): string {
  return buyerVatExplanation(d);
}

/** The engine's reasons, for staff (admin composer, notes, alerts). */
export function vatStaffExplanation(d: VatDecision): string {
  return d.reasons.filter((r) => !/^No delivery country yet/.test(r)).join(' ');
}
