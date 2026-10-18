import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineVat, type TaxSettings } from '@/lib/tax/determine';
import { offerVatLines, vatExplanation, vatReviewRefusal, vatStaffExplanation } from './engine';

const settings: TaxSettings = {
  homeCountry: 'NL', standardRateBp: 2100, shippingFollowsMain: true, icsEnabled: true, icsRequireVies: true,
  viesDownPolicy: 'MANUAL_REVIEW', exportZeroEnabled: true, euB2cMode: 'HOME_RATE', marginSchemeEnabled: true,
  salesMode: 'B2B_ONLY', legalTexts: { ICS: 'ICS', EXPORT: 'EXPORT', MARGIN: 'MARGIN', OSS: 'OSS' },
};
const countries = { isEu: (c: string) => ['NL', 'DE', 'BE'].includes(c), standardRateBp: () => 2100 };

test('offer lines: a margin-scheme line carries its purchase cost; a standard line none', async () => {
  const margin = await offerVatLines({ goodsCents: 50_000, shippingCents: 15_000, scheme: 'MARGIN', productId: null, purchaseCostCents: 42_000 });
  assert.deepEqual(margin, [
    { netCents: 50_000, lineType: 'GOODS', scheme: 'MARGIN', purchaseCostCents: 42_000 },
    { netCents: 15_000, lineType: 'SHIPPING' },
  ]);
  const standard = await offerVatLines({ goodsCents: 50_000, shippingCents: 0, scheme: 'STANDARD', productId: 'p1' });
  assert.deepEqual(standard, [{ netCents: 50_000, lineType: 'GOODS', scheme: 'STANDARD' }]);
  // A sourced item (no listing) without a cost: the engine reports it to staff only.
  const sourced = await offerVatLines({ goodsCents: 50_000, shippingCents: 0, scheme: 'MARGIN', productId: null });
  assert.equal(sourced[0].purchaseCostCents, null);
});

test('margin offer with a recorded cost: the buyer reads only the margin-scheme explanation', async () => {
  const lines = await offerVatLines({ goodsCents: 50_000, shippingCents: 15_000, scheme: 'MARGIN', productId: null, purchaseCostCents: 42_000 });
  const d = determineVat({ shipToCountry: 'NL', billingCountry: 'NL', customerKind: 'BUSINESS', vatId: null, lines }, settings, countries);
  assert.equal(vatExplanation(d), 'Margin scheme for second-hand goods: the VAT is included in the price and not shown separately; VAT 21% is charged on the freight only.');
  assert.doesNotMatch(vatExplanation(d), /purchase cost|Delivery in/);
  assert.match(vatStaffExplanation(d), /Margin-scheme items/);
});

test('acceptance refusal on a VAT review: buyer-safe cause and only the steps that can help', () => {
  const vies = (vatId: { status: 'UNAVAILABLE' | 'NOT_CHECKED' | 'VALID'; name?: string }, legal?: string) =>
    determineVat({
      shipToCountry: 'BE', billingCountry: 'BE', customerKind: 'BUSINESS', buyerLegalName: legal ?? null,
      vatId: { vatId: 'BE0417497106', country: 'BE', status: vatId.status, formatValid: true, name: vatId.name ?? null },
      lines: [{ netCents: 50_000, lineType: 'GOODS' }],
    }, settings, countries);
  const staffWords = /policy|review required|VAT ID belongs to|before 0%/i;

  // VAT ID registered to another company: retrying or dropping the ID is not the answer.
  const mismatch = vies({ status: 'VALID', name: 'NV Anheuser-Busch InBev' }, 'G4 Brussels Research Lab NV');
  const m = vatReviewRefusal(mismatch, { hasVatId: true, vatIdOptional: true });
  assert.match(m, /lists VAT ID BE0417497106 for “NV Anheuser-Busch InBev”, not for “G4 Brussels Research Lab NV”/);
  assert.match(m, /Check the VAT ID and the company name/);
  assert.doesNotMatch(m, /try again|remove the VAT ID/i);
  assert.doesNotMatch(m, staffWords);

  // VIES did not answer: try again later; dropping the ID only where it is optional.
  const down = vies({ status: 'UNAVAILABLE' });
  assert.match(vatReviewRefusal(down, { hasVatId: true, vatIdOptional: true }), /could not check your VAT ID .* Please try again later — our team has been notified, or remove the VAT ID/);
  assert.doesNotMatch(vatReviewRefusal(down, { hasVatId: true, vatIdOptional: false }), /remove the VAT ID/, 'the VAT ID is required for this country');
  assert.doesNotMatch(vatReviewRefusal(down, { hasVatId: true, vatIdOptional: true }), staffWords);

  // Not checked (VIES checks off): waiting does not help.
  const notChecked = vatReviewRefusal(vies({ status: 'NOT_CHECKED' }), { hasVatId: true, vatIdOptional: true });
  assert.doesNotMatch(notChecked, /try again/i);
  assert.match(notChecked, /will confirm the VAT with you/);
});
