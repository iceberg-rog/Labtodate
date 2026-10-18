import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerCardProps, type SrForOffer } from './offer-view';

const future = new Date(Date.now() + 10 * 86_400_000);

// A margin-scheme unit with freight, sent to a buyer with billing details on file.
const marginOffer: SrForOffer = {
  id: 'cmq1', status: 'RESPONDED', quotedPriceCents: 50_000, quotedCurrency: 'EUR', quotedNote: null, quotedAt: new Date(), validUntilAt: future,
  proformaNumber: null, productCategory: null, product: { title: 'Agilent 1260 HPLC' }, offerRevision: 1,
  offerSubtotalCents: 50_000, offerShippingCents: 15_000, offerVatTreatment: 'MARGIN_SCHEME', offerVatRateBp: 0, offerVatCents: 3_150, offerTotalCents: 68_150,
  offerTerms: {
    qty: 1, unitCents: 50_000, paymentTerms: { kind: 'PREPAY', days: 14, text: 'x' },
    vatBasis: { status: 'DECIDED', country: 'NL', vatId: null, reasons: [], legalText: null, shippingRateBp: 2100, buyerLabel: 'Margin scheme — VAT included in the price' },
  },
};

test('offer card after a refresh: margin item with freight reads "VAT 21% on freight", buyer wording for the buyer', () => {
  const buyer = offerCardProps(marginOffer, null, 'BUYER')!;
  assert.equal(buyer.amounts.vatRowLabel, 'VAT 21% on freight');
  assert.equal(buyer.amounts.vatLabel, 'Margin scheme — VAT included in the price');
  assert.equal(buyer.amounts.vatCents, 3_150);
  const staff = offerCardProps(marginOffer, null, 'STAFF')!;
  assert.equal(staff.amounts.vatRowLabel, 'VAT 21% on freight', 'never "VAT 0%" next to €31.50, for staff either');
  assert.equal(staff.amounts.vatLabel, 'Margin scheme (second-hand goods)');
  // An older offer without the recorded label: buyer wording from the treatment.
  const older = offerCardProps({ ...marginOffer, offerTerms: { ...(marginOffer.offerTerms as object), vatBasis: { status: 'DECIDED', shippingRateBp: 2100 } } }, null, 'BUYER')!;
  assert.equal(older.amounts.vatLabel, 'Margin scheme — VAT included in the price');
});

test('accepted-order card: the label recorded at acceptance (CHARGE_HOME_VAT with a VAT ID)', () => {
  const decidedAt = new Date('2026-10-18T09:00:00Z');
  const sr: SrForOffer = { ...marginOffer, status: 'ACCEPTED', offerVatTreatment: 'EU_B2C_HOME', offerVatRateBp: 2100 };
  const order = {
    orderNumber: 'L2D-2026-ABC123', status: 'PENDING_PAYMENT', subtotalCents: 50_000, shippingCents: 15_000, taxCents: 13_650, totalCents: 78_650, currency: 'EUR',
    vatTreatment: 'EU_B2C_HOME', vatRateBp: 2100, shippingVatRateBp: 2100, buyerVatId: 'DE123456789', vatDecidedAt: decidedAt,
    pricingSnapshot: { buyerVat: { treatment: 'EU_B2C_HOME', decidedAt: decidedAt.toISOString(), label: 'Home VAT (VAT ID not yet confirmed — credited later)', title: 'VAT 21%' } },
    items: [{ quantity: 1, priceCentsSnapshot: 50_000 }],
  };
  const buyer = offerCardProps(sr, order, 'BUYER')!;
  assert.equal(buyer.amounts.vatLabel, 'Home VAT (VAT ID not yet confirmed — credited later)');
  assert.equal(buyer.amounts.vatRowLabel, 'VAT 21%');
  assert.doesNotMatch(buyer.amounts.vatLabel ?? '', /without VAT ID/);
  assert.equal(offerCardProps(sr, order, 'STAFF')!.amounts.vatLabel, 'EU buyer without VAT ID (home rate)');
});
