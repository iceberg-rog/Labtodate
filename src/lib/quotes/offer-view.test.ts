import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VatDecision } from '@/lib/tax/determine';
import { buyerVatExplanation, offerCardProps, offerFormProps, offerItemPrefill, offerItemTitle, parseOfferItem, priceLockedMessage } from './offer-view';
import type { OfferDefaults } from './policy';

const terms = {
  v: 1, qty: 1, unitCents: 900_000, incoterm: 'DAP', incotermPlace: 'Berlin, DE', leadTime: null, warranty: null,
  paymentTerms: { kind: 'PREPAY', days: 14, text: 'Payment within 14 days.' },
  vatBasis: { status: 'AT_ACCEPTANCE', country: null, vatId: null, reasons: [], legalText: null, shippingRateBp: null },
  itemTitle: 'Zeiss LSM 980, 2021, SN 2802001234', itemDescription: 'Confocal microscope, 4 lasers', itemCondition: 'USED', itemSerial: '2802001234',
  destinationCountry: 'DE', allowUnpublished: false,
};

const sr = (over: Record<string, unknown> = {}) => ({
  id: 'cmquote0000000000abc123', status: 'RESPONDED', quotedPriceCents: 900_000, quotedCurrency: 'EUR', quotedNote: null,
  quotedAt: new Date('2026-10-01T10:00:00Z'), validUntilAt: new Date(Date.now() + 7 * 86_400_000), proformaNumber: null,
  productCategory: 'confocal microscope', product: null, offerRevision: 2, offerSubtotalCents: 900_000, offerShippingCents: 30_000,
  offerTerms: terms, lostReason: null, lostNote: null, ...over,
});

test('the offered item is read from offerTerms; unknown values are dropped', () => {
  assert.deepEqual(parseOfferItem(terms), {
    itemTitle: 'Zeiss LSM 980, 2021, SN 2802001234', itemDescription: 'Confocal microscope, 4 lasers', itemCondition: 'USED', itemSerial: '2802001234',
    destinationCountry: 'DE', allowUnpublished: false,
  });
  assert.deepEqual(parseOfferItem({ itemCondition: 'MINT', destinationCountry: 'Germany', allowUnpublished: 'yes' }), {
    itemTitle: null, itemDescription: null, itemCondition: null, itemSerial: null, destinationCountry: null, allowUnpublished: false,
  });
  assert.equal(parseOfferItem(null).itemTitle, null);
});

test('the goods line: the offer title, else the listing, else the request — never HTML entities', () => {
  assert.equal(offerItemTitle(sr()), 'Zeiss LSM 980, 2021, SN 2802001234');
  assert.equal(offerItemTitle({ offerTerms: null, product: { title: 'Leica TCS SP8 &#8211; confocal &amp; STED' }, productCategory: 'x' }), 'Leica TCS SP8 – confocal & STED');
  assert.equal(offerItemTitle({ offerTerms: null, product: null, productCategory: 'confocal microscope' }), 'confocal microscope');
  assert.equal(offerItemTitle({ offerTerms: null, product: null, productCategory: null }), 'Requested equipment');
  assert.equal(offerCardProps(sr(), null, 'BUYER')?.itemTitle, 'Zeiss LSM 980, 2021, SN 2802001234');
});

test('composer prefill: a request without its own listing needs a title', () => {
  assert.equal(offerItemPrefill({ offerTerms: null, product: null, productCategory: 'x', productId: null }).titleRequired, true);
  assert.equal(offerItemPrefill({ offerTerms: null, product: { title: 'A &amp; B' }, productId: 'p1', similarToProductId: null }).itemTitle, 'A & B');
  assert.equal(offerItemPrefill({ offerTerms: null, product: { title: 'A' }, productId: 'p1', similarToProductId: null }).titleRequired, false);
  assert.equal(offerItemPrefill({ offerTerms: null, product: null, productId: null, similarToProductId: 'p9' }).titleRequired, true);
});

test('buyer VAT wording never repeats the engine’s staff reasons', () => {
  const d = (treatment: VatDecision['treatment'], rateBp: number, shippingRateBp = rateBp, freight = true) => ({
    treatment, rateBp, shippingRateBp,
    lines: [{ index: 0, lineType: 'GOODS' as const, treatment, rateBp, netCents: 100, taxCents: 0, marginVatCents: 0 }, ...(freight ? [{ index: 1, lineType: 'SHIPPING' as const, treatment, rateBp: shippingRateBp, netCents: 10, taxCents: 0, marginVatCents: 0 }] : [])],
  });
  for (const t of ['DOMESTIC_STANDARD', 'EU_ICS_ZERO', 'EU_B2C_HOME', 'EU_B2C_OSS', 'EXPORT_ZERO', 'MARGIN_SCHEME', 'REVIEW_REQUIRED'] as const) {
    const text = buyerVatExplanation(d(t, t.endsWith('ZERO') ? 0 : 2100));
    assert.doesNotMatch(text, /policy|keep the export evidence|Shipping follows the goods|review required before invoicing/i, `${t}: ${text}`);
  }
  assert.equal(buyerVatExplanation(d('DOMESTIC_STANDARD', 2100)), 'VAT 21% applies to this delivery.');
  assert.match(buyerVatExplanation(d('MARGIN_SCHEME', 0, 2100)), /Freight: VAT 21%/);
  assert.equal(buyerVatExplanation({ ...d('EU_ICS_ZERO', 0), buyerExplanation: 'From the engine.' }), 'From the engine.');
});

test('a declined offer can be re-quoted on the same request; closed and accepted ones cannot', () => {
  const defaults: OfferDefaults = {
    currency: 'EUR', currencies: ['EUR'], shippingCents: 0, incoterms: ['EXW', 'DAP'], incoterm: 'EXW', incotermPlace: 'Zoetermeer, NL',
    leadTime: '', warrantyFallback: '', paymentTermDays: 14, paymentTermsText: '', validDays: 14,
  };
  const ctx = { mode: 'STAFF' as const, recipientLabel: 'buyer', defaults, vat: null as never };
  const declined = offerFormProps(sr({ status: 'DECLINED', lostReason: 'Price too high' }), null, ctx);
  assert.ok(declined, 'the composer is offered on a declined quote');
  assert.equal(declined?.current?.revision, 2);
  assert.equal(offerFormProps(sr({ status: 'CLOSED' }), null, ctx), null);
  assert.equal(offerFormProps(sr({ status: 'ACCEPTED' }), { orderNumber: 'L2D-1', status: 'PENDING_PAYMENT' }, ctx), null);
});

test('the locked-price message names the buttons that exist', () => {
  const canceled = priceLockedMessage({ status: 'ACCEPTED', proformaNumber: 'PF-2026-00006' }, { orderNumber: 'L2D-1', status: 'CANCELED' });
  assert.match(canceled ?? '', /New quote for this buyer/);
  const open = priceLockedMessage({ status: 'ACCEPTED', proformaNumber: 'PF-2026-00006' }, { orderNumber: 'L2D-1', status: 'PENDING_PAYMENT' });
  assert.match(open ?? '', /Cancel order/);
  assert.match(open ?? '', /New quote for this buyer/);
  assert.doesNotMatch(`${canceled} ${open}`, /open a new quote for the buyer/i);
  assert.equal(priceLockedMessage({ status: 'RESPONDED', proformaNumber: null }, null), null);
});
