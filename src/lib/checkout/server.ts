import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingBool, settingEnum, settingList, settingString } from '@/lib/settings';
import { stripeConfigured } from '@/lib/stripe/client';
import { checkCountry, countryOptions, type CountryDecision } from '@/lib/compliance/country';
import { quoteShippingFor } from '@/lib/shipping/load';
import type { ShippingQuote } from '@/lib/shipping/quote';
import { checkVatId, type VatIdCheckResult } from '@/lib/tax/vies';
import { determineVat, vatTreatmentLabel, type VatDecision } from '@/lib/tax/determine';
import { loadCountryFacts, loadTaxSettings } from '@/lib/tax/settings';
import { parseVatId } from '@/lib/tax/vatid';
import { loadPriceDisplay, sellPriceOf } from '@/lib/pricing/server';
import type { PriceDisplaySettings } from '@/lib/pricing/display';
import { reserveAndCreateOrder } from '@/lib/orders/checkout-tx';
import { orderLineTruthFor } from '@/lib/catalog/order-snapshot';
import {
  assembleCheckout,
  primaryHold,
  shippingLinesOf,
  vatLinesOf,
  type CheckoutComputation,
  type CheckoutRefusal,
  type HoldTexts,
  type PricedLine,
} from './engine';
import {
  billingCountryOf,
  isBusiness,
  validateCheckoutFields,
  vatIdFor,
  type CheckoutFormValues,
  type CheckoutRules,
  type PaymentMethodCode,
} from './input';
import type { VatIdRule } from '@/lib/orders/details';
import { PAYMENT_METHOD_LABEL, type CheckoutQuoteView } from './view';

/**
 * Checkout on the server: loads the lines (resolved sell prices), runs the
 * country policy, the shipping quote, VIES and the VAT engine, and creates the
 * order with exactly the numbers the buyer was shown. Used by both checkouts
 * (single product and cart) — one path, one set of rules.
 */

export type CheckoutSource = { kind: 'single'; slug: string } | { kind: 'cart' };

const PRODUCT_SELECT = {
  id: true,
  slug: true,
  title: true,
  priceCents: true,
  currency: true,
  mode: true,
  status: true,
  quantity: true,
  priceOnHold: true,
  vatScheme: true,
  shippingClass: true,
  weightKg: true,
  images: true,
  brand: { select: { name: true } },
  company: { select: { pricingMode: true, pricingMarkupBp: true } },
} satisfies Prisma.ProductSelect;

type LoadedProduct = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

export interface LoadedLines {
  lines: PricedLine[];
  images: Record<string, string[]>;
  /** For the guarded stock reservation: the raw catalogue price the buyer saw. */
  reservations: Array<{ productId: string; quantity: number; expectedPriceCents: number; expectedCurrency: string }>;
  cartRows: Array<{ id: string; quantity: number }> | null;
  refusal: CheckoutRefusal | null;
}

function lineOf(p: LoadedProduct, qty: number): { line: PricedLine | null; why: string | null } {
  const r = sellPriceOf(p);
  if (!r.buyable || r.sellPriceCents == null || r.basePriceCents == null) {
    return { line: null, why: r.reasons[0] ?? 'This item cannot be bought online — request a quote.' };
  }
  if (qty > p.quantity) return { line: null, why: p.quantity <= 0 ? 'Sold out.' : `Only ${p.quantity} available.` };
  return {
    line: {
      productId: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand?.name ?? null,
      qty,
      unitCents: r.sellPriceCents,
      baseUnitCents: r.basePriceCents,
      appliedMarkupBp: r.appliedMarkupBp,
      currency: p.currency,
      vatScheme: p.vatScheme,
      shippingClass: p.shippingClass,
      weightKg: p.weightKg,
    },
    why: null,
  };
}

export async function loadCheckoutLines(userId: string, source: CheckoutSource): Promise<LoadedLines> {
  const out: LoadedLines = { lines: [], images: {}, reservations: [], cartRows: null, refusal: null };
  const rows: Array<{ p: LoadedProduct | null; qty: number; cartId?: string }> = [];
  if (source.kind === 'single') {
    const p = await prisma.product.findUnique({ where: { slug: source.slug }, select: PRODUCT_SELECT });
    rows.push({ p, qty: 1 });
  } else {
    const items = await prisma.cartItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, quantity: true, product: { select: PRODUCT_SELECT } },
    });
    out.cartRows = items.map((i) => ({ id: i.id, quantity: i.quantity }));
    for (const i of items) rows.push({ p: i.product, qty: i.quantity, cartId: i.id });
  }
  if (!rows.length) {
    out.refusal = { code: 'EMPTY', message: 'Your cart is empty.' };
    return out;
  }
  const problems: string[] = [];
  for (const row of rows) {
    if (!row.p) {
      problems.push('This product no longer exists.');
      continue;
    }
    const { line, why } = lineOf(row.p, row.qty);
    if (!line) {
      problems.push(`${row.p.title}: ${why}`);
      continue;
    }
    out.lines.push(line);
    out.images[line.productId] = row.p.images;
    out.reservations.push({ productId: row.p.id, quantity: row.qty, expectedPriceCents: row.p.priceCents as number, expectedCurrency: row.p.currency });
  }
  if (problems.length) {
    out.refusal = { code: 'UNAVAILABLE', message: `Not everything can be ordered as it is: ${problems.join(' ')} No order was created.` };
  }
  return out;
}

// ── settings for the checkout page ───────────────────────────────────────────

export interface CheckoutSettings {
  rules: CheckoutRules;
  display: PriceDisplaySettings;
  declarationText: string;
  termsNote: string;
  texts: HoldTexts;
  submitLabels: CheckoutQuoteView['submitLabels'];
  icsEnabled: boolean;
  homeCountry: string;
}

export function availablePaymentMethods(): PaymentMethodCode[] {
  const enabled = settingList('PAYMENT_METHODS_ENABLED') as string[];
  const out: PaymentMethodCode[] = [];
  if (enabled.includes('BANK_TRANSFER')) out.push('BANK_TRANSFER');
  if (enabled.includes('STRIPE_CARD') && stripeConfigured()) out.push('STRIPE_CARD');
  return out;
}

export async function loadCheckoutSettings(userId: string | null): Promise<CheckoutSettings> {
  await ensureSettingsLoaded();
  const profile = userId ? await prisma.billingProfile.findUnique({ where: { userId }, select: { poRequired: true } }) : null;
  return {
    rules: {
      salesMode: settingEnum('SALES_MODE'),
      requireCompanyAndId: settingBool('B2B_REQUIRE_COMPANY_AND_ID'),
      poMode: settingEnum('CHECKOUT_PO_NUMBER'),
      poRequiredByProfile: !!profile?.poRequired,
      askInvoiceEmail: settingBool('CHECKOUT_ASK_INVOICE_EMAIL'),
      requirePhone: settingBool('CHECKOUT_REQUIRE_PHONE'),
      paymentMethods: availablePaymentMethods(),
      vatIdRule: settingEnum<VatIdRule>('DETAILS_VAT_ID_REQUIRED'),
    },
    display: await loadPriceDisplay(),
    declarationText: settingString('B2B_DECLARATION_TEXT'),
    termsNote: settingString('CHECKOUT_TERMS_NOTE'),
    texts: {
      SHIPPING_PENDING: settingString('CHECKOUT_MSG_SHIPPING_PENDING'),
      COMPLIANCE: settingString('CHECKOUT_MSG_COMPLIANCE_REVIEW'),
      VAT_REVIEW: settingString('CHECKOUT_MSG_VAT_REVIEW'),
    },
    submitLabels: {
      bank: settingString('CHECKOUT_SUBMIT_TEXT_BANK'),
      card: settingString('CHECKOUT_SUBMIT_TEXT_CARD'),
      hold: settingString('CHECKOUT_SUBMIT_TEXT_HOLD'),
      consumer: settingString('CONSUMER_ORDER_BUTTON_TEXT'),
    },
    icsEnabled: settingBool('TAX_ICS_ZERO_RATE_ENABLED'),
    homeCountry: settingString('TAX_HOME_COUNTRY').toUpperCase() || 'NL',
  };
}

// ── VIES (cached; a short memory for "unavailable" so a down member state
//    does not make every keystroke wait for the 10 s timeout) ────────────────

const g = globalThis as unknown as { __l2dViesDown?: Map<string, { at: number; r: VatIdCheckResult }> };
const viesDown = (g.__l2dViesDown ??= new Map());

async function vatIdEvidence(raw: string): Promise<VatIdCheckResult | null> {
  if (!raw) return null;
  const p = parseVatId(raw);
  const key = p?.vatId ?? raw;
  const hit = viesDown.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.r;
  const r = await checkVatId(raw);
  if (r.status === 'UNAVAILABLE') viesDown.set(key, { at: Date.now(), r });
  else viesDown.delete(key);
  return r;
}

function vatIdMessage(r: VatIdCheckResult): string {
  switch (r.status) {
    case 'VALID':
      return `Confirmed by VIES${r.name ? `: ${r.name}` : ''}${r.consultationNumber ? ` (consultation ${r.consultationNumber})` : ''}.`;
    case 'INVALID':
      return r.source === 'FORMAT'
        ? r.error ?? 'This is not a valid EU VAT ID.'
        : 'VIES says this VAT ID is not valid — VAT is charged as for a buyer without a VAT ID.';
    case 'UNAVAILABLE':
      return `VIES could not be reached for this VAT ID right now${r.error ? ` (${r.error})` : ''}.`;
    default:
      return 'Not checked with VIES (checks are switched off).';
  }
}

/** Buyer-facing VAT sentence (Settings → Tax & VAT → Checkout VAT text …). */
function buyerVatText(treatment: string, vars: Record<'COUNTRY' | 'RATE' | 'HOME_COUNTRY', string>): string {
  const key: Record<string, string> = {
    DOMESTIC_STANDARD: 'VAT_TEXT_DOMESTIC',
    EU_ICS_ZERO: 'VAT_TEXT_ICS',
    EU_B2C_HOME: 'VAT_TEXT_EU_HOME',
    EU_B2C_OSS: 'VAT_TEXT_OSS',
    EXPORT_ZERO: 'VAT_TEXT_EXPORT',
    MARGIN_SCHEME: 'VAT_TEXT_MARGIN',
  };
  const tpl = settingString(key[treatment] ?? 'VAT_TEXT_REVIEW');
  return tpl.replace(/\{(COUNTRY|RATE|HOME_COUNTRY)\}/g, (_, k: 'COUNTRY' | 'RATE' | 'HOME_COUNTRY') => vars[k]).trim();
}

// ── the quote ────────────────────────────────────────────────────────────────

export interface CheckoutQuoteResult {
  view: CheckoutQuoteView;
  comp: CheckoutComputation;
  loaded: LoadedLines;
  shipTo: CountryDecision;
  billing: CountryDecision | null;
  vatId: VatIdCheckResult | null;
  decision: VatDecision;
  settings: CheckoutSettings;
}

export async function computeCheckout(userId: string, source: CheckoutSource, v: CheckoutFormValues, settings?: CheckoutSettings): Promise<CheckoutQuoteResult> {
  const s = settings ?? (await loadCheckoutSettings(userId));
  const loaded = await loadCheckoutLines(userId, source);
  const currency = loaded.lines[0]?.currency ?? 'EUR';
  const shipTo = await checkCountry(v.country);
  const bc = billingCountryOf(v);
  const billing = bc && bc !== v.country ? await checkCountry(bc) : null;

  const shippingQuote: ShippingQuote = shipTo.mode === 'BLOCK' || !loaded.lines.length
    ? { status: 'TO_BE_CONFIRMED', reasons: [] }
    : await quoteShippingFor(shipTo.country, shippingLinesOf(loaded.lines), currency);
  const shippingCents = shippingQuote.status === 'QUOTED' ? shippingQuote.amountCents : 0;

  const vatRaw = vatIdFor(v);
  const vatId = await vatIdEvidence(vatRaw);
  const [taxSettings, countries] = await Promise.all([loadTaxSettings(), loadCountryFacts()]);
  const decision = determineVat(
    {
      shipToCountry: /^[A-Z]{2}$/.test(v.country) ? v.country : null,
      billingCountry: /^[A-Z]{2}$/.test(bc) ? bc : null,
      customerKind: isBusiness(v.customerType) ? 'BUSINESS' : 'CONSUMER',
      vatId: vatId && vatId.country ? vatId : null,
      lines: vatLinesOf(loaded.lines, shippingCents),
    },
    taxSettings,
    countries,
  );
  const comp = assembleCheckout({ lines: loaded.lines, shipTo, billing, shipping: shippingQuote, vat: decision, texts: s.texts });
  const refusal = loaded.refusal ?? comp.refusal ?? (s.rules.paymentMethods.length ? null : { code: 'NO_PAYMENT_METHOD', message: 'Online ordering is switched off at the moment (no payment method is enabled). Please request a quote instead.' });

  const hints: string[] = [];
  const euElsewhere = countries.isEu(v.country) && v.country !== s.homeCountry;
  if (isBusiness(v.customerType) && euElsewhere && s.icsEnabled && !vatRaw) {
    hints.push(`Buying for a company in ${shipTo.name ?? v.country}? Add your EU VAT ID: a VIES-confirmed VAT ID from another EU country makes this an intra-EU supply at 0% VAT.`);
  }
  const explanation = buyerVatText(comp.vat.treatment, {
    COUNTRY: shipTo.name ?? shipTo.country,
    RATE: comp.vat.rateBp != null ? `${(comp.vat.rateBp / 100).toFixed(2).replace(/\.?0+$/, '')}%` : '',
    HOME_COUNTRY: (await checkCountry(s.homeCountry)).name ?? s.homeCountry,
  });

  // What the buyer commits to per unit: its condition and warranty (the same
  // snapshot the order line and the invoice will carry).
  const truthNow = await orderLineTruthFor(comp.lines.map((l) => l.productId));
  const view: CheckoutQuoteView = {
    canOrder: !refusal,
    refusal,
    currency,
    displayMode: s.display.mode,
    labels: { excl: s.display.labelExcl, incl: s.display.labelIncl },
    lines: comp.lines.map((l) => ({
      productId: l.productId, slug: l.slug, title: l.title, brand: l.brand, qty: l.qty,
      unitNetCents: l.unitCents, lineNetCents: l.lineCents, vatRateBp: l.vatRateBp, taxCents: l.taxCents,
      conditionLabel: truthNow.get(l.productId)?.conditionSnapshot ?? null,
      warranty: truthNow.get(l.productId)?.warrantySnapshot ?? null,
    })),
    goodsCents: comp.goodsCents,
    shipping: {
      status: comp.shipping.status,
      cents: comp.shipping.cents,
      zone: comp.shipping.zone,
      leadTime: comp.shipping.leadTime,
      note: comp.shipping.status === 'TO_BE_CONFIRMED'
        ? 'To be confirmed by our team'
        : comp.shipping.cents === 0
          ? 'Free shipping'
          : comp.shipping.zone ? `Zone ${comp.shipping.zone}` : 'Shipping',
    },
    vat: {
      treatment: comp.vat.treatment,
      label: vatTreatmentLabel(comp.vat.treatment),
      rateBp: comp.vat.rateBp,
      review: comp.vat.review,
      rows: comp.vat.rows,
      legalText: comp.vat.legalText,
      explanation,
    },
    vatId: vatId
      ? { input: vatRaw, status: vatId.status, name: vatId.name ?? null, consultationNumber: vatId.consultationNumber ?? null, message: vatIdMessage(vatId) }
      : null,
    country: { code: shipTo.country, name: shipTo.name ?? shipTo.country, mode: shipTo.mode },
    holds: comp.holds.map((h) => ({ code: h.code, message: h.message })),
    taxCents: comp.taxCents,
    totalCents: comp.totalCents,
    hints,
    paymentMethods: s.rules.paymentMethods.map((code) => ({
      code,
      label: PAYMENT_METHOD_LABEL[code],
      note: code === 'BANK_TRANSFER'
        ? 'You receive a proforma with our bank details; we ship once the transfer is verified.'
        : 'You continue to Stripe’s secure card page.',
    })),
    submitLabels: s.submitLabels,
  };
  return { view, comp, loaded, shipTo, billing, vatId, decision, settings: s };
}

// ── placing the order ────────────────────────────────────────────────────────

export type PlaceResult =
  | { ok: false; message: string; fieldErrors: Record<string, string>; quote: CheckoutQuoteView | null; changed?: boolean }
  | {
      ok: true;
      order: { id: string; orderNumber: string };
      holds: string[];
      holdMessages: string[];
      paymentMethod: PaymentMethodCode;
      totalCents: number;
      currency: string;
      itemSummary: string;
      lines: Array<{ title: string; qty: number; unitCents: number }>;
      shippingCents: number;
      taxCents: number;
      vatLabel: string;
    };

function addressJson(a: { name: string; phone?: string; email?: string | null; company?: string | null; line1: string; line2: string; city: string; postal: string; state: string; country: string }, extra: Record<string, unknown> = {}) {
  return {
    name: a.name,
    ...(a.phone !== undefined ? { phone: a.phone } : {}),
    ...(a.email ? { email: a.email } : {}),
    ...(a.company ? { company: a.company } : {}),
    ...extra,
    address: {
      line1: a.line1,
      line2: a.line2 || null,
      city: a.city,
      postal_code: a.postal,
      state: a.state || null,
      country: a.country,
    },
  };
}

export async function placeCheckoutOrder(
  user: { id: string; email: string; name: string },
  source: CheckoutSource,
  v: CheckoutFormValues,
  meta: { buyerIp: string | null; buyerCountry: string | null },
): Promise<PlaceResult> {
  const settings = await loadCheckoutSettings(user.id);
  const fieldErrors = validateCheckoutFields(v, settings.rules);
  const q = await computeCheckout(user.id, source, v, settings);
  if (q.view.refusal) {
    return { ok: false, message: `${q.view.refusal.message}`, fieldErrors, quote: q.view };
  }
  if (Object.keys(fieldErrors).length) {
    return { ok: false, message: 'Please check the highlighted fields — no order was created yet.', fieldErrors, quote: q.view };
  }
  const { comp } = q;
  const ex = v.expected;
  if (ex.total !== comp.totalCents || (ex.tax != null && ex.tax !== comp.taxCents) || (ex.shipping != null && ex.shipping !== comp.shipping.cents)) {
    return {
      ok: false,
      changed: true,
      message: 'The total changed since it was shown (address, VAT ID or a price update). Please check the updated summary and place the order again — nothing was ordered yet.',
      fieldErrors: {},
      quote: q.view,
    };
  }
  const business = isBusiness(v.customerType);
  const holds = comp.holds.map((h) => h.code);
  const hold = primaryHold(holds);
  const paymentMethod = (settings.rules.paymentMethods.includes(v.paymentMethod as PaymentMethodCode)
    ? v.paymentMethod
    : settings.rules.paymentMethods[0]) as PaymentMethodCode;
  const now = new Date();
  const vatId = q.vatId;
  const invoiceEmail = settings.rules.askInvoiceEmail && v.invoiceEmail ? v.invoiceEmail : null;
  const shippingAddress = addressJson({ ...v, email: user.email, company: business ? v.company || null : null });
  const billingSrc = v.billingSame ? { ...v, name: v.name } : { ...v.billing, name: v.billing.name || v.name };
  const billingAddress = addressJson(
    { ...billingSrc, phone: v.phone, email: invoiceEmail ?? user.email, company: business ? v.company || null : null },
    business ? { ...(v.vatId ? { vat: vatId?.vatId || v.vatId } : {}), ...(v.kvk ? { kvk: v.kvk } : {}) } : {},
  );
  const pricingSnapshot = {
    v: 1,
    at: now.toISOString(),
    source: source.kind,
    displayMode: settings.display.mode,
    lines: comp.lines.map((l) => ({
      productId: l.productId, title: l.title, qty: l.qty, unitCents: l.unitCents, baseUnitCents: l.baseUnitCents,
      appliedMarkupBp: l.appliedMarkupBp, vatRateBp: l.vatRateBp, taxCents: l.taxCents,
    })),
    shipping: comp.shipping,
    vat: { ...comp.vat, decidedAt: now.toISOString() },
    vatId: vatId ? { vatId: vatId.vatId, status: vatId.status, name: vatId.name ?? null, consultationNumber: vatId.consultationNumber ?? null, source: vatId.source, checkedAt: vatId.checkedAt ?? null, error: vatId.error ?? null } : null,
    country: { shipTo: q.shipTo, billing: q.billing },
    holds: comp.holds,
    paymentMethod,
    totals: { goodsCents: comp.goodsCents, shippingCents: comp.shipping.cents, taxCents: comp.taxCents, totalCents: comp.totalCents },
  };
  const truth = await orderLineTruthFor(comp.lines.map((l) => l.productId));
  const result = await reserveAndCreateOrder(prisma, {
    reservations: q.loaded.reservations,
    orderData: {
      buyerId: user.id,
      status: 'PENDING_PAYMENT',
      subtotalCents: comp.goodsCents,
      shippingCents: comp.shipping.cents,
      taxCents: comp.taxCents,
      totalCents: comp.totalCents,
      currency: comp.currency,
      paidAt: null,
      buyerIp: meta.buyerIp,
      buyerCountry: meta.buyerCountry,
      shippingAddress: shippingAddress as Prisma.InputJsonValue,
      billingAddress: billingAddress as Prisma.InputJsonValue,
      vatTreatment: comp.vat.treatment,
      vatRateBp: comp.vat.rateBp,
      vatDecidedAt: now,
      vatNote: comp.vat.reasons.join(' ').slice(0, 2000),
      buyerVatId: business && vatId?.vatId ? vatId.vatId : null,
      viesCheck: (vatId ? pricingSnapshot.vatId : undefined) as Prisma.InputJsonValue | undefined,
      shippingTaxed: comp.vat.shippingRateBp > 0,
      shippingVatRateBp: comp.vat.review ? null : comp.vat.shippingRateBp,
      customerType: v.customerType,
      b2bDeclarationAt: business && v.b2bDeclaration ? now : null,
      poNumber: business && v.poNumber ? v.poNumber : null,
      invoiceEmail,
      pricingSnapshot: pricingSnapshot as unknown as Prisma.InputJsonValue,
      holdReason: hold,
      holdNote: hold ? comp.holds.map((h) => `${h.code}: ${h.detail}`).join(' | ').slice(0, 2000) : null,
      holdAt: hold ? now : null,
      openHolds: holds,
      payableSince: hold ? null : now,
    },
    items: comp.lines.map((l) => ({
      productId: l.productId,
      titleSnapshot: l.title,
      brandSnapshot: l.brand,
      priceCentsSnapshot: l.unitCents,
      quantity: l.qty,
      lineType: 'GOODS',
      basePriceCents: l.baseUnitCents,
      appliedMarkupBp: l.appliedMarkupBp,
      vatRateBp: comp.vat.review ? null : l.vatRateBp,
      taxCents: comp.vat.review ? null : l.taxCents,
      ...truth.get(l.productId),
    })),
    ...(source.kind === 'cart' && q.loaded.cartRows ? { cartClear: { userId: user.id, items: q.loaded.cartRows } } : {}),
  });
  if (!result.ok) {
    if (result.reason === 'unavailable') {
      return { ok: false, message: 'An item was sold, reserved or changed a moment ago, so no order was created and nothing is due. Please check the items and try again.', fieldErrors: {}, quote: null };
    }
    if (result.reason === 'cart-changed') {
      return { ok: false, message: 'Your cart changed while you were checking out (another tab?). No order was created — please review the summary and try again.', fieldErrors: {}, quote: null };
    }
    throw result.error instanceof Error ? result.error : new Error('order create failed');
  }

  if (v.saveProfile) {
    const profile = {
      customerType: v.customerType,
      legalName: (business ? v.company : '') || billingSrc.name || v.name,
      contactName: v.name,
      vatId: business ? vatId?.vatId || v.vatId || null : null,
      vatValidationId: business ? vatId?.validationId ?? null : null,
      kvkNumber: business ? v.kvk || null : null,
      address: { line1: billingSrc.line1, line2: billingSrc.line2 || null, postalCode: billingSrc.postal, city: billingSrc.city, region: billingSrc.state || null, country: billingSrc.country },
      country: billingSrc.country,
      invoiceEmail,
      phone: v.phone || null,
    };
    await prisma.billingProfile
      .upsert({ where: { userId: user.id }, create: { userId: user.id, ...profile }, update: profile })
      .catch(() => null); // the order exists; a profile save must never undo it
  }

  return {
    ok: true,
    order: result.order,
    holds,
    holdMessages: comp.holds.map((h) => h.message),
    paymentMethod,
    totalCents: comp.totalCents,
    currency: comp.currency,
    itemSummary: comp.lines.length === 1 ? comp.lines[0].title : `${comp.lines.length} items`,
    lines: comp.lines.map((l) => ({ title: l.title, qty: l.qty, unitCents: l.unitCents })),
    shippingCents: comp.shipping.cents,
    taxCents: comp.taxCents,
    vatLabel: comp.vat.rows.length === 1 && comp.vat.rateBp != null
      ? `VAT ${(comp.vat.rateBp / 100).toString()}% (${vatTreatmentLabel(comp.vat.treatment)})`
      : 'VAT',
  };
}

// ── prefill ──────────────────────────────────────────────────────────────────

export async function checkoutPrefill(user: { id: string; name: string }, settings: CheckoutSettings): Promise<CheckoutFormValues> {
  const [profile, last] = await Promise.all([
    prisma.billingProfile.findUnique({ where: { userId: user.id } }),
    prisma.order.findFirst({
      where: { buyerId: user.id, shippingAddress: { not: Prisma.JsonNull } },
      orderBy: { createdAt: 'desc' },
      select: { shippingAddress: true, poNumber: true },
    }),
  ]);
  const ship = (last?.shippingAddress ?? null) as { name?: string; phone?: string; address?: Record<string, string | null> } | null;
  const a = ship?.address ?? {};
  const pa = (profile?.address ?? {}) as Record<string, string | null>;
  const options = await countryOptions();
  const known = (c: string | null | undefined) => (c && options.some((o) => o.code === c) ? c : '');
  const shipCountry = known(String(a.country ?? '')) || known(profile?.country) || settings.homeCountry;
  const billingSame = !profile || (String(pa.line1 ?? '') === String(a.line1 ?? '') && String(pa.city ?? '') === String(a.city ?? ''));
  const consumerAllowed = settings.rules.salesMode === 'B2B_AND_B2C';
  return {
    source: 'single',
    slug: '',
    name: ship?.name ?? profile?.contactName ?? user.name ?? '',
    phone: ship?.phone ?? profile?.phone ?? '',
    line1: String(a.line1 ?? pa.line1 ?? ''),
    line2: String(a.line2 ?? pa.line2 ?? ''),
    city: String(a.city ?? pa.city ?? ''),
    postal: String(a.postal_code ?? pa.postalCode ?? ''),
    state: String(a.state ?? pa.region ?? ''),
    country: shipCountry,
    customerType: profile?.customerType === 'CONSUMER' && consumerAllowed ? 'CONSUMER' : profile?.customerType === 'INSTITUTION' ? 'INSTITUTION' : 'BUSINESS',
    company: profile && profile.customerType !== 'CONSUMER' ? profile.legalName : '',
    kvk: profile?.kvkNumber ?? '',
    vatId: profile?.vatId ?? '',
    billingSame,
    billing: {
      name: profile?.contactName ?? '',
      line1: String(pa.line1 ?? ''),
      line2: String(pa.line2 ?? ''),
      city: String(pa.city ?? ''),
      postal: String(pa.postalCode ?? ''),
      state: String(pa.region ?? ''),
      country: known(profile?.country) || shipCountry,
    },
    invoiceEmail: profile?.invoiceEmail ?? '',
    poNumber: '',
    paymentMethod: settings.rules.paymentMethods[0] ?? '',
    b2bDeclaration: false,
    saveProfile: true,
    expected: { total: null, tax: null, shipping: null },
  };
}
